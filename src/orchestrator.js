import { routeCompletion } from './providers.js';
import { getModel, chooseModel } from './catalog.js';
import { d1ContextStore, renderHandoff, mergeContext } from './context.js';
import { detectToolProposal } from './tools.js';

const now=()=>Date.now();
const clean=x=>String(x??'').trim();
const json=(x)=>{try{return JSON.parse(x)}catch{return null}};

async function event(env,taskId,type,payload={}){
  await env.DB.prepare('INSERT INTO task_events (id,task_id,type,payload_json,created_at) VALUES (?,?,?,?,?)')
    .bind(crypto.randomUUID(),taskId,type,JSON.stringify(payload),now()).run();
}
async function readTask(env,taskId){
  const row=await env.DB.prepare('SELECT id,chat_id,task_json,plan_json FROM tasks WHERE id=?').bind(taskId).first();
  if(!row)throw new Error('المهمة غير موجودة');
  return {row,task:JSON.parse(row.task_json),plan:row.plan_json?JSON.parse(row.plan_json):null};
}
async function save(env,task,plan){
  await env.DB.prepare('UPDATE tasks SET task_json=?,plan_json=?,updated_at=? WHERE id=?')
    .bind(JSON.stringify(task),JSON.stringify(plan),now(),task.id).run();
}
async function control(env,taskId){return await env.DB.prepare('SELECT status FROM task_control WHERE task_id=?').bind(taskId).first();}

function currentStep(plan){return plan?.steps?.find(x=>x.status==='running'||x.status==='retrying')||plan?.steps?.find(x=>x.status==='pending')||null;}
function parseDecision(raw){
  const found=clean(raw).match(/\{[\s\S]*\}/)?.[0];
  const parsed=found?json(found):null;
  if(parsed&&typeof parsed==='object')return parsed;
  const proposal=detectToolProposal(raw);
  return proposal?{status:'needs_tool',output:clean(raw),command:proposal.command,language:proposal.language}:({status:'complete',output:clean(raw)});
}

export async function advanceTask(env,taskId,{modelId=null,maxSteps=3}={}){
  const leaseId=crypto.randomUUID(), leaseUntil=now()+120000;
  await env.DB.prepare('INSERT INTO task_runtime (task_id,lease_id,lease_until,phase,last_error,next_run_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET lease_id=?,lease_until=?,phase=?,last_error=NULL,updated_at=? WHERE task_runtime.lease_until<? OR task_runtime.lease_id=?')
    .bind(taskId,leaseId,leaseUntil,'running',null,null,now(),leaseId,leaseUntil,'running',now(),now(),leaseId).run();
  const held=await env.DB.prepare('SELECT lease_id,lease_until,phase FROM task_runtime WHERE task_id=?').bind(taskId).first();
  if(!held||held.lease_id!==leaseId)return {status:'already_running',taskId,phase:held?.phase||'running'};
  const release=async(phase='idle',error=null)=>env.DB.prepare('UPDATE task_runtime SET lease_id=NULL,lease_until=0,phase=?,last_error=?,updated_at=? WHERE task_id=? AND lease_id=?').bind(phase,error,now(),taskId,leaseId).run();
  let state=await readTask(env,taskId), {task,plan}=state;
  if(!plan)throw new Error('لا توجد خطة للمهمة');
  const ctl=await control(env,taskId);
  if(ctl?.status==='paused'){await release('paused');return {task,plan,status:'paused',reason:'paused'};}
  if(ctl?.status==='cancelled'){await release('cancelled');return {task,plan,status:'cancelled',reason:'cancelled'};}
  const waitingStep=plan.steps.find(x=>x.status==='awaiting_approval');
  if(waitingStep&&task.status==='awaiting_approval'){await release('waiting_for_approval');return {task,plan,status:'waiting_for_approval',stepId:waitingStep.id};}
  if(task.status==='planning'||task.status==='awaiting_approval')task={...task,status:'running',updatedAt:now()};
  let last=null;
  for(let count=0;count<Math.max(1,Math.min(5,maxSteps));count++){
    const renewed=await env.DB.prepare('UPDATE task_runtime SET lease_until=?,updated_at=? WHERE task_id=? AND lease_id=?').bind(now()+120000,now(),taskId,leaseId).run();
    const latest=await control(env,taskId);
    if(latest?.status==='paused'||latest?.status==='cancelled'){task={...task,status:latest.status,currentStepId:task.currentStepId,updatedAt:now()};break;}
    const step=currentStep(plan);
    if(!step){task={...task,status:'completed',currentStepId:null,updatedAt:now()};await save(env,task,plan);await event(env,task.id,'task_completed',{});await release('completed');break;}
    if(step.status==='pending'||step.status==='retrying'){
      step.status='running';task.currentStepId=step.id;task.status='running';task.updatedAt=now();
      plan={...plan,steps:plan.steps.map(x=>x.id===step.id?{...x,status:'running',startedAt:now()}:x)};
      await save(env,task,plan);await event(env,task.id,'step_started',{stepId:step.id,title:step.title});
    }
    const stateMem=await d1ContextStore(env.DB).get(task.conversationId);
    const model=getModel(modelId||chooseModel(`${task.goal}\n${step.description}`).id);
    const prompt=`نفّذ الخطوة الحالية فقط ثم أعد JSON صالحًا دون Markdown بالشكل:
{"status":"complete|needs_tool|blocked|retry","output":"نتيجة مختصرة دقيقة","command":"اختياري","language":"bash|python|none","verification":"كيف تحققت"}
المهمة: ${task.goal}
الخطوة: ${step.title}
التفاصيل: ${step.description}
معيار النجاح: ${step.successCriteria||'نتيجة صحيحة قابلة للتحقق'}
تعقيبات المستخدم الأخيرة: ${(task.interventions||[]).slice(-5).map(x=>x.content).join('\n')||'لا يوجد'}
السياق: ${renderHandoff(stateMem,[])}`;
    const r=await routeCompletion(env,model.id,[{role:'system',content:'أنت منفذ خطوات FOX AI. لا تدّع تنفيذ أداة. إذا احتجت الطرفية أعد needs_tool مع command فقط.'},{role:'user',content:prompt}],{maxTokens:1800,temperature:.1});
    const decision=parseDecision(r.text);last={stepId:step.id,model:r.actual,decision};
    await event(env,task.id,'model_called',{stepId:step.id,model:r.actual.id||r.actual.model,status:decision.status});
    if(decision.status==='needs_tool'&&clean(decision.command)){
      plan={...plan,steps:plan.steps.map(x=>x.id===step.id?{...x,status:'awaiting_approval',tool:'terminal',command:decision.command,language:decision.language||'bash'}:x)};
      task={...task,status:'awaiting_approval',currentStepId:step.id,updatedAt:now()};await save(env,task,plan);await event(env,task.id,'tool_requested',{stepId:step.id,command:decision.command});
      await release('waiting_for_approval');return {task,plan,status:'waiting_for_tool_approval',proposal:{kind:'terminal',command:decision.command,language:decision.language||'bash',taskId:task.id,stepId:step.id}};
    }
    if(decision.status==='blocked'){
      plan={...plan,steps:plan.steps.map(x=>x.id===step.id?{...x,status:'awaiting_approval',output:decision.output}:x)};
      task={...task,status:'awaiting_approval',currentStepId:step.id,updatedAt:now()};await save(env,task,plan);await event(env,task.id,'approval_requested',{stepId:step.id,reason:decision.output});await release('waiting_for_input');return {task,plan,status:'waiting_for_user',reason:decision.output};
    }
    if(decision.status==='retry'){
      const attempts=(step.attempts||0)+1;const failed=attempts>=3;
      plan={...plan,steps:plan.steps.map(x=>x.id===step.id?{...x,status:failed?'failed':'retrying',attempts,error:decision.output,output:decision.output}:x)};
      task={...task,status:failed?'failed':'recovering',currentStepId:step.id,updatedAt:now()};await save(env,task,plan);await event(env,task.id,'verification_failed',{stepId:step.id,error:decision.output,attempts});if(failed){await release('failed',decision.output);return {task,plan,status:'failed'};}continue;
    }
    const output=clean(decision.output)||r.text;
    plan={...plan,steps:plan.steps.map(x=>x.id===step.id?{...x,status:'completed',output,evidence:decision.verification?[decision.verification]:[],completedAt:now()}:x)};
    await event(env,task.id,'verification_passed',{stepId:step.id,output:output.slice(0,2000)});
    const next=plan.steps.find(x=>x.status==='pending');task={...task,status:next?'running':'completed',currentStepId:next?.id||null,updatedAt:now()};
    const mem=mergeContext(stateMem,{summary:output.slice(0,500),next:next?.title||'اكتملت المهمة'});await d1ContextStore(env.DB).put(task.conversationId,mem);await save(env,task,plan);
  }
  await release(task.status==='completed'?'completed':'idle');return {task,plan,status:task.status,last};
}

export async function addIntervention(env,taskId,content){
  const {task,plan}=await readTask(env,taskId);const item={id:crypto.randomUUID(),content:clean(content).slice(0,8000),createdAt:now()};
  const blocked=plan?.steps?.find(x=>x.status==='awaiting_approval'&&x.tool!=='terminal');
  const nextPlan=blocked?{...plan,steps:plan.steps.map(x=>x.id===blocked.id?{...x,status:'running',output:null}:x)}:plan;
  const next={...task,status:blocked?'running':task.status,interventions:[...(task.interventions||[]),item],currentStepId:blocked?.id||task.currentStepId,updatedAt:now()};await save(env,next,nextPlan);await event(env,taskId,'user_intervention',{content:item.content});return {task:next,plan:nextPlan};
}
export async function taskEvents(env,taskId){const r=await env.DB.prepare('SELECT id,type,payload_json,created_at FROM task_events WHERE task_id=? ORDER BY created_at ASC LIMIT 300').bind(taskId).all();return (r.results||[]).map(x=>({...x,payload:json(x.payload_json)||{}}));}
