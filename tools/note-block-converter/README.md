# 音源 → 音ブロック 変換のまとめ

Java 版向け。調べた結果と、自作した変換ツール **oto2noteblock** の使い方。

## まず結論

| やりたいこと | おすすめ |
|---|---|
| MP3/WAV などの音声から、そのまま設計図や鯖への設置まで | **oto2noteblock**（自作、このフォルダ） |
| MIDI から設計図を作りたい（26.2 / 1.21.11 の Litematica） | **oto2noteblock**、またはブラウザだけで済む **Notematic Studio** |
| 曲を見ながら手で直したい・試聴したい | **Open Note Block Studio**（MIDI を読み込んで編集、.nbs 保存） |
| 装置を作らずに鯖で曲を流したい | **Notica**（Fabric の鯖 MOD、.nbs を `/music play`）か Note Block Studio のデータパック書き出し |

音声ファイルは、まず **Basic Pitch**（Spotify の無料の採譜 AI）で MIDI にしてから音ブロックにします。oto2noteblock はこれを自動でやります。

## 調べたツール

| ツール | 入力 | 出力 | 費用 | メモ |
|---|---|---|---|---|
| [Basic Pitch](https://basicpitch.spotify.com/) | 音声 | MIDI | 無料 | ブラウザで使える。ボーカルや混ざった音源は音が多めに出るので、楽器ソロや耳コピ用の音源が向いている |
| [Open Note Block Studio](https://opennbs.org/)（3.11.0、2024-12） | MIDI / .nbs | .nbs、設計図（.schematic、構造ブロック .nbt）、データパック、音声 | 無料・Windows | 定番。3.12 ベータで Litematica 向け .nbt も出せる。1.21 以降の書き出しに対応 |
| [Notematic Studio](https://cayde26-notematic-studio.hf.space/) | MIDI、声の録音 | .litematic、.mcfunction、MP3 試聴 | 無料・ブラウザ | 音声ファイル（曲）は直接入れられない |
| [midi-to-noteblock](https://github.com/SushiWaUmai/midi-to-noteblock) | MIDI | WorldEdit 設計図 | 無料・Python | 古め |
| [Notica](https://modrinth.com/mod/notica) | .nbs | 鯖で再生 | 無料・Fabric | 1.20.4〜1.21.11。鯖だけに入れればよく、参加者は MOD 不要。26.2 版はまだ無い |

どれも「音声 → 26.2 用の設計図 → 鯖へ直接設置」までは一つで通らないので、そこを埋めるために oto2noteblock を作りました。

## oto2noteblock の使い方

### 準備（PC で一度だけ）

1. Python 3.10 以上を入れる（https://www.python.org/ 。インストール時に「Add python.exe to PATH」にチェック）
2. PowerShell で:
   ```
   pip install mido
   ```
3. 音声ファイルも使うなら（MIDI だけなら不要）:
   ```
   pip install basic-pitch[onnx]
   ```
   Python 3.11 以上で上がエラーになる時は、次の順で入れます（実機の Python 3.12 で確認済み）:
   ```
   pip install --no-deps basic-pitch==0.4.0
   pip install onnxruntime librosa mir-eval pretty-midi "resampy<0.4.3" scikit-learn scipy typing-extensions "numpy<2" "setuptools<81"
   ```
   tensorflow が無いという警告が出ますが動きます。
   うまく入らない時は、https://basicpitch.spotify.com/ に音声を入れて MIDI をダウンロードし、その .mid を使えば同じことができます。

### 変換する

```
python oto2noteblock.py 曲.mp3
python oto2noteblock.py 曲.mid
python oto2noteblock.py 曲.nbs
```

入力と同じ場所に次のファイルができます。

| ファイル | 使い道 |
|---|---|
| `曲.litematic` | Litematica で読み込んで設置（既定は 26.2 用） |
| `曲.schem` | WorldEdit で `//schem load` |
| `曲.nbs` | Open Note Block Studio で開いて試聴・手直し。直した .nbs をもう一度このツールに入れれば装置にできる。Notica で再生もできる |
| `曲_place.mcfunction` | データパックに入れて `/function` で設置（実行した人の足元が角） |
| `曲_basicpitch.mid` | 音声から作った MIDI（音声を入れた時だけ） |

### よく使うオプション

| オプション | 意味 |
|---|---|
| `--mc 1.21.11` | 1.21.11 の鯖用の設計図にする（既定 26.2。ほか 1.21.4、1.21.1、1.20.4、1.20.1、1.19.4） |
| `--row-length 64` | 64 ブロックごとに上へ折り返して箱形にまとめる。長い曲はこれがおすすめ（一直線だと 3 分の曲で 1000 ブロック以上になる） |
| `--max-lanes 12` | 同時に鳴らす音の最大数。多いほど原曲に近いが装置が太くなる（1 本 3 ブロック幅） |
| `--speed 0.9` | 速さの倍率。速すぎて音がつぶれる曲は少し遅くすると聞きやすい |
| `--instruments pitch` | 楽器を高さだけで決める（低音 ベース・中音 ハープ・高音 ベル）。音声から作る時はこれもおすすめ |
| `--instruments single:bell` | 全部同じ楽器にする |
| `--min-velocity 40` | 弱い音を捨てる（音声から作って雑音が多い時に） |
| `--onset 0.7` | 音声解析で音の出だしを厳しく判定（音が多すぎる時は上げる、少ない時は下げる） |

### 鯖へ直接置く（RCON）

```
python oto2noteblock.py 曲.mid --row-length 64 --rcon 127.0.0.1:25575 --rcon-password パスワード --origin 100 -60 200
```

`--origin` の座標を角にして、そこから x と z のプラス方向・上へ設置します。設置したあと、表示された座標のスタートボタンを押すと鳴ります。遠く離れても鳴らし続けたい時は `--keep-loaded` を付けます（チャンクを読み込んだままにする）。

### 装置のしくみと注意

- 同時に鳴る音の数だけ「レーン」を並べ、どのレーンも同じ並び（反復装置 → 音ブロック → 反復装置 …）なので同じタイミングで鳴ります。スタートは 1 か所のボタンで全レーン同時。
- 時間の細かさはレッドストーン 1 ティック（0.1 秒）。それより細かい連打は同じタイミングにまとまります。
- 音ブロック 1 つの音域は 2 オクターブなので、外れた音は別の楽器（ベース・ベル）に回し、それでも外れる時はオクターブを移します。
- 音ブロックの真上は空気にしておく必要があります（設計図はそうなっています。上に物を置かないでください）。
- 鳴るのは近くのチャンクが読み込まれている間だけです。一直線の長い装置は、聞く人が装置と一緒に移動するか、`--row-length` で箱形にしてください。
- 音声からの採譜は完璧ではありません。歌入りの曲は音が多すぎたり外れたりするので、`曲.nbs` を Note Block Studio で開いて聞き、いらない音を消してから入れ直すときれいになります。

## 確認したこと

- 実際の 26.2 の鯖（PC、バニラ 26.2）に RCON で設置し、ボタンを押して各音ブロックが鳴ったゲームティックを記録（`ingame_test.py`）。30 秒の試験曲（312 音、和音・ベース・ドラム・休み入り）で、折り返し（33×30×18）と一直線（223×3×17）の両方とも 312 個すべてが鳴り、間隔のずれは 0。
- その曲を音声（WAV）にして入れた場合も、Basic Pitch で 297 音の MIDI になり、装置にして 297 個すべてが予定どおり鳴った。
- 配線をたどる計算（`simcheck.py`）でも、80 秒・922 音の曲と 40 レーンの曲で同じ結果。
- .litematic は litemapy、.schem は NBT として読み込めることを確認。Litematica・WorldEdit での実際の貼り付けはまだ試していません。
