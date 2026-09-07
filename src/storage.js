const API='https://api.github.com';
const headers=(token,extra={})=>({authorization:`Bearer ${token}`,accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...extra});
const repoOf=env=>env.GITHUB_ASSET_REPO||env.GITHUB_REPO;
async function gh(env,path,init={}){if(!env.GITHUB_TOKEN)throw new Error('GITHUB_TOKEN غير مهيأ لتخزين الملفات');const target=String(path).startsWith('http')?path:`${API}${path}`;return fetch(target,{...init,headers:headers(env.GITHUB_TOKEN,init.headers||{})});}
export const MAX_DIRECT_UPLOAD=80*1024*1024;
export async function latestRelease(env){
  const repo=repoOf(env);if(!repo)throw new Error('GITHUB_ASSET_REPO غير مهيأ');
  if(env.GITHUB_RELEASE_ID){const r=await gh(env,`/repos/${repo}/releases/${env.GITHUB_RELEASE_ID}`);if(!r.ok)throw new Error(`تعذر قراءة Release: HTTP ${r.status}`);return await r.json();}
  const r=await gh(env,`/repos/${repo}/releases/latest`);if(!r.ok)throw new Error('أنشئ Release تخزينًا في مستودع GitHub الخاص ثم أعد المحاولة');return await r.json();
}
export async function uploadReleaseAsset(env,{name,mime,bytes}){
  if(!(bytes instanceof ArrayBuffer)&&!(bytes instanceof Uint8Array))throw new Error('بيانات الملف غير صالحة');
  const size=bytes.byteLength;if(size>MAX_DIRECT_UPLOAD)throw new Error('الملف يتجاوز حد الرفع المباشر 80MB');
  const release=await latestRelease(env),repo=repoOf(env),safe=String(name||'file').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,180)||'file';
  const url=`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(`${Date.now()}-${safe}`)}`;
  const r=await gh(env,url.replace(API,''),{method:'POST',headers:headers(env.GITHUB_TOKEN,{'content-type':mime||'application/octet-stream','content-length':String(size)}),body:bytes});
  if(!r.ok)throw new Error(`فشل رفع Release Asset: HTTP ${r.status}`);const asset=await r.json();return {assetId:asset.id,name:asset.name,size:asset.size,mime:asset.content_type||mime||'application/octet-stream',url:asset.browser_download_url,storage:'github_release'};
}
export async function downloadReleaseAsset(env,assetId){const repo=repoOf(env);if(!repo||!assetId)throw new Error('بيانات التخزين غير مكتملة');const r=await gh(env,`/repos/${repo}/releases/assets/${assetId}`,{headers:{accept:'application/octet-stream'}});if(!r.ok)throw new Error(`تعذر تنزيل Release Asset: HTTP ${r.status}`);return r;}
