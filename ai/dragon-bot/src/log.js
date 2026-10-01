const t = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (...a) => console.log(`[${t()}]`, ...a),
  warn: (...a) => console.warn(`[${t()}] 警告:`, ...a),
  error: (...a) => console.error(`[${t()}] エラー:`, ...a),
  brain: (...a) => console.log(`[${t()}] 🧠`, ...a),
  skill: (...a) => console.log(`[${t()}] 🛠`, ...a),
};
