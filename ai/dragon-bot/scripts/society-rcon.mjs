// 社会実験鯖に RCON でコマンドを送る（鯖のコンソールを開かなくても設定できるように）。
// 使い方:
//   node scripts/society-rcon.mjs setup            ゲームルールを入れる（下の SETUP）
//   node scripts/society-rcon.mjs record           広場（0, 0）のまわり半径 6 チャンクの録画を始める（ServerReplay。Replay Mod で再生）
//   node scripts/society-rcon.mjs "list"           任意のコマンド
//   SOCIETY_SERVER_DIR=... で鯖のフォルダを変えられる（既定 Documents\ClaudeCode\society-server。rcon.txt を読む）
import { rconSend } from '../src/society/rcon.js';

// 1.21.11 からゲームルールの名前は小文字のスネークケース（keep_inventory など）
const SETUP = [
  'gamerule keep_inventory true', // 死んでも持ち物を失わない（社会づくりが死のたびに振り出しに戻らないように）
  'gamerule players_sleeping_percentage 30', // 3 割が寝れば朝になる（全員そろって寝るのは難しい）
  'gamerule spawn_phantoms false', // ファントムを出さない（家の屋根の上から襲ってくる）
  'gamerule respawn_radius 2', // 全員が広場の近くに湧く
  'difficulty easy',
];

const args = process.argv.slice(2);
const RECORD = ['replay start chunks around 0 0 radius 6', 'replay status'];
const commands = args[0] === 'setup' ? SETUP : args[0] === 'record' ? RECORD : args;
if (!commands.length) { console.error('コマンドを指定してください（setup か "list" など）'); process.exit(1); }
const res = await rconSend(commands);
commands.forEach((c, i) => console.log(`> ${c}\n${res[i] ?? ''}`));
