      if (b.action === 'step_control') return stepControl(env, b);
      if (b.action === 'get_experiment') return getExperiment(env, b);
      if (b.action === 'get_experiments') return getExperiments(env, b);
      if (b.action === 'cancel_experiment') return cancelExperimentRun(env, b);
      if (b.action === 'download_file') return downloadFile(env, b);
      if (b.action === 'get_attachment') return getAttachmentFull(env, b);
      if (b.action === 'get_attachments') return getAttachmentsList(env, b);
      if (b.action === 'tool_proposal') return toolProposal(env, b);
      if (b.action === 'tool_budget') return toolBudget(env, b);
      if (b.action === 'request_autopilot') return requestAutopilot(env, b);
      if (b.action === 'stop_autopilot') return stopAutopilot(env, b);
      if (b.action === 'renew_tool_budget') return renewToolBudget(env, b);
      if (b.action === 'workspace_status') return workspaceStatus(env, b);
      if (b.action === 'run_tool') return runTool(env, b);
      if (b.action === 'usage') return json(await getUsageFromGateway(env));
      if (['settings_get', 'settings_set'].includes(b.action)) return settings(env, b);
      if (['rename_conversation', 'delete_conversation'].includes(b.action)) return conversationControl(env, b);
      if (['cancel_task', 'pause_task', 'resume_task'].includes(b.action)) return taskControl(env, b);
      return json({ error: 'إجراء غير معروف' }, 404);
    } catch (e) {
      console.error(e);
      const status = e instanceof ProviderError ? e.status : 500;
      return json({ error: e.message || 'خطأ داخلي', provider: e.provider || null, retryable: !!e.retryable }, status);
    }
  },
};
