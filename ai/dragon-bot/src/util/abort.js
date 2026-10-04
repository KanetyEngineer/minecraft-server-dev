// 中断（時間切れ・反射・フリーズ回避）を受けたのに、スキルの中の待ち（経路探し・採掘・窓の操作など）が
// いつまでも終わらないことがある。そのままだとボットは次の判断に進めず、その場に立ったままになる。
// promise と中断の合図を競わせ、中断から graceMs たっても終わらなければ見切って先に進む。
// 見切った promise が後でエラーになっても、処理されないエラーにならないよう握りつぶす。
export function untilAborted(promise, signal, { graceMs = 5000, onAbandon } = {}) {
  promise.catch(() => {});
  if (!signal) return promise;
  let timer = null;
  let onAbort = null;
  const abandoned = new Promise((_, reject) => {
    const fire = () => {
      timer = setTimeout(() => {
        onAbandon?.();
        const e = new Error(`中断（${signal.reason ?? '中断'}）に応じなかったので見切った`);
        e.name = 'AbortError';
        reject(e);
      }, graceMs);
    };
    if (signal.aborted) fire();
    else { onAbort = fire; signal.addEventListener('abort', onAbort, { once: true }); }
  });
  abandoned.catch(() => {});
  return Promise.race([promise, abandoned]).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}
