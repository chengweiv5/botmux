process.send?.({ ready: true });
process.once('message', async (message: { port: number; accessKey: string }) => {
  const statuses: number[] = [];
  for (const [route, body] of [['lark-tool-identity', { mode: 'user' }], ['auth-request', { scopes: ['im:chat:read'] }], ['auth-status', { requestId: 'stale' }]] as const) {
    const response = await fetch(`http://127.0.0.1:${message.port}/api/sessions/tool-session/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': message.accessKey }, body: JSON.stringify(body),
    });
    statuses.push(response.status);
    await response.text();
  }
  process.send?.({ statuses });
});
