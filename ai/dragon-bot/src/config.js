// 設定は環境変数から読む（.env ファイルがあれば Node の --env-file で渡す）。
// API キーなどの秘密情報はリポジトリに入れない。

function num(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig() {
  return {
    host: process.env.MC_HOST || '127.0.0.1',
    port: num('MC_PORT', 25570),
    username: process.env.MC_USERNAME || 'DragonBot',
    // offline: online-mode=false の試験鯖用。microsoft: 本物のアカウントでログイン。
    auth: process.env.MC_AUTH || 'offline',
    // 空なら接続先から自動判別。
    version: process.env.MC_VERSION || '1.21.11',

    // 方針判断に使う LLM（Claude）。キーが無ければルールベースで動く。
    llm: {
      enabled: bool('LLM_ENABLED', true),
      model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
      effort: process.env.CLAUDE_EFFORT || 'medium',
      // 拒否時にサーバー側で別モデルに引き継ぐ（Claude API のみ）。
      fallbacks: bool('CLAUDE_FALLBACKS', true),
      chat: bool('LLM_CHAT', true),
      // 1 回の判断をこれ以上待たない（ミリ秒）。超えたらルールベースで動く
      timeoutMs: num('LLM_TIMEOUT_MS', 45_000),
    },

    // 人間らしさの調整
    human: {
      // 鉱石などを探すとき、空気や水に接していて「見えている」ブロックだけを対象にする（透視しない）。
      visibleOnly: bool('HUMAN_VISIBLE_ONLY', true),
      // 視点移動の速さ（度/ティック）。小さいほどゆっくり。
      turnSpeed: num('HUMAN_TURN_SPEED', 35),
      // 行動の合間の考える時間（ミリ秒）
      thinkDelayMs: num('HUMAN_THINK_DELAY_MS', 800),
    },

    // 1 スキルの最大実行時間（秒）
    skillTimeoutSec: num('SKILL_TIMEOUT_SEC', 600),
    dataDir: process.env.DATA_DIR || 'data',
    // ブラウザで現在の状態を見る簡易ダッシュボード（0 で無効）
    statusPort: num('STATUS_PORT', 3007),
    logDir: process.env.LOG_DIR || 'logs',
    // チームで協力するときの役割（leader / food / iron）と、状態を共有するフォルダ
    role: process.env.ROLE || 'leader',
    teamDir: process.env.TEAM_DIR || 'team',
  };
}

// effort・adaptive thinking・fallbacks を使えない安いモデル（Haiku 4.5 など）か
export function isLiteModel(model) {
  return /haiku/i.test(model ?? '');
}
