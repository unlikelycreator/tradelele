const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll an order until it is no longer OPEN or `timeoutMs` passes; returns the last status. */
export async function waitForFinal(broker, orderId, inst, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const st = await broker.getOrder(orderId, inst);
    if (st.status !== 'OPEN' || Date.now() > until) return st;
    await sleep(broker.kind === 'live' ? 800 : 20);
  }
}

/** Wait for a fill; if still working at the deadline, cancel the rest and report what filled. */
export async function waitForFill(broker, orderId, inst, timeoutMs) {
  const r = await waitForFinal(broker, orderId, inst, timeoutMs);
  if (r.status !== 'OPEN') return r;
  await broker.cancelOrder(orderId, inst).catch(() => {});
  return waitForFinal(broker, orderId, inst, 5000);
}

export { sleep };
