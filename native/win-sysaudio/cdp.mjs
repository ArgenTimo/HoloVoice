// Evaluate an expression in an Electron page over the DevTools protocol (Windows CI test).
// node cdp.mjs <port> <url part> <expression>
const [,, port, target, expr] = process.argv
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((p) => p.type === 'page' && p.url.includes(target))
if (!page) { console.log(JSON.stringify({ error: 'no page', pages: list.map((p) => p.url) })); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id === 1) { console.log(JSON.stringify(d.result?.result?.value ?? d.result ?? d.error)); ws.close() }
}
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
