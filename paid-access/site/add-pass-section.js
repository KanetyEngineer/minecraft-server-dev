// games-site の HP に参加券の案内を足す（本番切替のときに1回だけ実行してから npm run deploy）
// 使い方: node add-pass-section.js C:/Users/kanek/Documents/ClaudeCode/games-site/public/index.html
// 同じフォルダに日時付きのバックアップを作る。2回目以降は何もしない
const fs = require("fs");

const file = process.argv[2];
if (!file) {
  console.error("index.html のパスを指定してください");
  process.exit(1);
}
let html = fs.readFileSync(file, "utf8");
const crlf = html.includes("\r\n");
if (crlf) html = html.replace(/\r\n/g, "\n");
if (html.includes('id="pass"')) {
  console.log("すでに入っています");
  process.exit(0);
}

const navAnchor = '  <a class="l" href="#servers">サーバー</a>\n';
const sectionAnchor = '<section id="servers">';
if (!html.includes(navAnchor) || !html.includes(sectionAnchor)) {
  console.error("差し込む場所が見つかりません（HP の構成が変わった？）");
  process.exit(1);
}

const section = `<section id="pass"><div class="wrap">
  <h2>参加券<small>ゲームのサーバーは月額の参加券を申し込んだ人が入れます。Kanety SMP は今まで通り無料です。</small></h2>
  <div class="grid g2">
    <div class="card">
      <h3>🎟 SharyTech Games 参加券</h3>
      <ol class="steps">
        <li><a href="https://pass.sharytech.com/">pass.sharytech.com</a> で、遊びたいゲームのプラン（各ゲーム月1,500円）か、全ゲームのコンプリートプラン（月8,000円）を選びます。</li>
        <li>Minecraft Java版のユーザー名を入れてカードで支払うと、1分ほどでそのゲームに入れるようになります。毎月自動で更新され、解約はいつでもできます。</li>
        <li>ロビーまでは参加券がなくても入れます。参加券がない状態でゲートに乗ると、申し込みページのリンクが出ます。</li>
      </ol>
      <p style="margin-top:12px"><a class="btn" href="https://pass.sharytech.com/">プランを見る</a></p>
    </div>
    <div class="card">
      <h3>🌱 Kanety SMP は無料</h3>
      <p>サバイバルの Kanety SMP は参加券がなくても、今まで通り誰でも遊べます。入り方は <a href="https://smp.sharytech.com/">smp.sharytech.com</a> を見てください。</p>
      <p class="note" style="margin-top:10px">申し込んだのに入れないときは、<a href="https://pass.sharytech.com/check">契約の確認</a>でユーザー名とプランを確かめてください。<a href="https://pass.sharytech.com/legal">特定商取引法に基づく表記</a></p>
    </div>
  </div>
</div></section>

`;

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
fs.copyFileSync(file, `${file}.bak-${stamp}`);
html = html.replace(navAnchor, '  <a class="l" href="#pass">参加券</a>\n' + navAnchor);
html = html.replace(sectionAnchor, section + sectionAnchor);
fs.writeFileSync(file, crlf ? html.replace(/\n/g, "\r\n") : html);
console.log("参加券の案内を足しました: " + file);
