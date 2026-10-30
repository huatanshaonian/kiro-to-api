// Surface the launch failure, rather than burying it behind an administrator notice.
export function startupFailure(exit, stderr) {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const actionable = lines.filter(line => /^(?:error:|error\[|Error:|\[ERROR\])/i.test(line));
  const detail = (actionable.length ? actionable.join('\n') : lines.filter(line =>
    !line.startsWith('Warning: Kiro CLI is running as Administrator.') &&
    !line.startsWith('Hide this warning:')).slice(-5).join('\n')).slice(-1200);
  return Object.assign(new Error('Kiro CLI exited before opening the model response (exit ' +
    (exit.code ?? exit.signal ?? 'unknown') + ').' + (detail ? ' ' + detail : '')),
    { status: 502, code: 'KIRO_STARTUP_FAILED' });
}
