# Quiver 専用ファーム

HID Remapper（[jfedor2/hid-remapper](https://github.com/jfedor2/hid-remapper) のコミット `51ab8b3`）に、Quiver 用の機能を足したものです。

## 書き込み（Waveshare RP2040-PiZero）

1. ボードの **BOOT** ボタンを押しながら、**USB** 側のポートを PC につなぐ
2. 「RPI-RP2」ドライブが出たら `quiver-remapper-rp2040-pizero.uf2` をドラッグ
3. ドライブが消えたら完了。Quiver で「HID Remapper Quiver3」と表示されます

元に戻すときは、公式の `remapper_waveshare_rp2040_pizero.uf2` を同じ手順で書き込みます。

## 公式との違い

- 「マウス・キーボード」の種類に、ゲームパッド（ボタン16個、ハットスイッチ、スティック2本）を追加。レイヤーでキーボード・マウスとコントローラーを瞬時に切り替えられる
- ゲームパッドのスティックを、最初から中央（128）にする
- 設定コマンド `64`：PC からレジスタを書き換える（自動切り替えで使用）
- 設定コマンド `65`：PC からマウスカーソルを動かす（外部ソフト用APIで使用）
- USB の製品名を「HID Remapper Quiver3」に変更

## 自分でビルドする

```
git clone https://github.com/jfedor2/hid-remapper
cd hid-remapper
git checkout 51ab8b367b810d1deb0d3e487e9b7fe8c7e9c24e
git submodule update --init --recursive
git apply /path/to/quiver-hid-remapper.patch
cd firmware && mkdir build && cd build
PICO_BOARD=waveshare_rp2040_pizero cmake ..
make remapper          # build/remapper.uf2 ができます
```
