// 設定は環境変数から読む（.env ファイルがあれば Node の --env-file で渡す）。
import { Vec3 } from 'vec3';

function num(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function vec(name) {
  const v = process.env[name];
  if (!v) return null;
  const [x, y, z] = v.split(/[ ,]+/).map(Number);
  return [x, y, z].every(Number.isFinite) ? new Vec3(x, y, z) : null;
}

export function loadConfig() {
  return {
    host: process.env.MC_HOST || '127.0.0.1',
    port: num('MC_PORT', 25572),
    username: process.env.MC_USERNAME || 'BuilderBot',
    // offline: online-mode=false の試験鯖用。microsoft: 本物のアカウントでログイン。
    auth: process.env.MC_AUTH || 'offline',
    version: process.env.MC_VERSION || '1.21.11',

    // チャットで指示できるプレイヤー（カンマ区切り）
    owners: (process.env.BUILD_OWNERS || 'kanetyyy').split(',').map((s) => s.trim()).filter(Boolean),
    // 設計図（.litematic）を置くフォルダ
    schematicDir: process.env.SCHEMATIC_DIR || 'schematics',
    // 起動したらすぐ建てる場合: 設計図の名前と、設計図の最小角を置く座標（"x,y,z"）
    buildFile: process.env.BUILD_FILE || '',
    // "here" なら、ボットのいる所の少し先に建てる
    buildOrigin: process.env.BUILD_ORIGIN === 'here' ? 'here' : vec('BUILD_ORIGIN'),
    // 設計図の範囲にある邪魔なブロック（地形・木）をどける
    clearArea: bool('BUILD_CLEAR', true),
    // 素材のそろえ方。stocked: 手持ちとチェストに用意してある素材だけで建てる（取り出し・クラフトのみ）
    //                 gather: 足りない素材は自分で採掘・精錬・狩り・クラフトして集める
    supplyMode: (process.env.BUILD_SUPPLY || 'gather').toLowerCase() === 'stocked' ? 'stocked' : 'gather',
    // 最初に石の道具をそろえる（gather のとき。stocked ではチェストにある道具を持つだけ）
    prepareTools: bool('BUILD_PREPARE_TOOLS', true),
    // 夜は穴にこもって朝を待つ（false なら夜も建て続ける）
    shelterAtNight: bool('BUILD_SHELTER_AT_NIGHT', true),
    // 昼のうちにベッドを作っておき、夜は穴の中で寝る
    useBed: bool('BUILD_USE_BED', true),
    // 1 回にそろえる素材の手間の上限（原木 1 本 ≒ 1。これを超える量はチェストに入れてもらう）
    gatherBudget: num('BUILD_GATHER_BUDGET', 800),
    // 素材を探すチェストの範囲（建築範囲の端からのブロック数）
    chestRadius: num('BUILD_CHEST_RADIUS', 16),
    // 素材が足りず止まったとき、チェストを見直すまでの待ち時間（秒）
    retryWaitSec: num('BUILD_RETRY_WAIT_SEC', 60),

    human: {
      visibleOnly: bool('HUMAN_VISIBLE_ONLY', true),
      turnSpeed: num('HUMAN_TURN_SPEED', 35),
    },
    dataDir: process.env.DATA_DIR || 'data',
    statusPort: num('STATUS_PORT', 3008),
    logDir: process.env.LOG_DIR || 'logs',
  };
}
