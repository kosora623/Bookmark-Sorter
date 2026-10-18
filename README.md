# Bookmark Sorter

大量の Twitter ブックマークをローカルに収集し、フォルダ分けして整理する Chrome 拡張機能です。

**非公式です。** Twitter(X) とは無関係で、公開 API は使いません。タイムラインの DOM を読んで収集し、解除時は画面上のボタンをクリックします。Twitter 側の HTML が変わると収集や解除が壊れることがあります。Twitter の利用規約に照らして自己責任で使ってください。

データはすべて端末内の IndexedDB に保存します。外部サーバーへ送る処理はありません。動画や画像のファイル本体は保存せず、URL だけを持ちます。ライセンスは [MIT](LICENSE) です。

## 導入

### 1. ファイルを用意する

この GitHub ページの右にある **Releases** から、最新版の zip をダウンロードして解凍します。

解凍した中に `manifest.json` があるフォルダが、拡張の本体です（名前は `dist` のことが多いです）。

### 2. Chrome に読み込む

1. Chrome で [chrome://extensions](chrome://extensions) を開く（アドレスバーに貼り付けて Enter）
2. 右上の **デベロッパーモード** をオンにする
3. 左上の **パッケージ化されていない拡張機能を読み込む** をクリックする
4. さきほどの `manifest.json` があるフォルダを選んで「フォルダーの選択」

コードを更新したあとは、同じ拡張機能の画面で **再読み込み** を押してください。

## 使い方

1. [x.com/i/history](https://x.com/i/history)（旧 [x.com/i/bookmarks](https://x.com/i/bookmarks)）を開く
2. 右下のオーバーレイで「100件を取得開始」
3. 未保存のポストを自動スクロールしながら取り込み、100件または最下部で停止

「ダッシュボードを開く」からも選別画面に入れます。

### 選別

ツールバーの拡張アイコン（ピン留め推奨）をクリックしてダッシュボードを開きます。

| キー | 動作 |
|---|---|
| `→` | 保存（選択中のフォルダへ） |
| `1`–`9` | 保存先フォルダを切替（リスト順。`1` は未分類） |
| `←` `←` | 削除（2回押し。1回目は確認、2秒以内にもう一度） |
| `↓` | スキップ（あとで再表示） |
| `O` | 元ポストを Twitter で開く |
| `Z` | 直前の操作を取り消し（最大 30 件） |
| `Enter` | フォルダ選択中なら保存 |

前回使ったフォルダは次回も選ばれたままです。

上部タブ「保存済み」で、フォルダ絞り込みつきの一覧を見られます。行をクリックすると Twitter で開きます。

1回目の `←` ではまだ消しません。カードが赤くなり、2秒以内にもう一度押すと削除します。`Esc`・他のキー・時間切れで確認は解除されます。

### バックアップ

ヘッダーの **エクスポート** で、全データ（ブックマーク・フォルダ）を JSON ファイルに保存できます。データは IndexedDB にしかないため、拡張を削除する前や PC を移すときは必ずエクスポートしてください。**インポート** で読み込むと、同じ ID のポストはファイルの内容（状態・フォルダ）で上書きします。

### 解除

削除後は **2 秒以内の Undo なら Twitter 側の解除もキャンセル** します。2 秒を過ぎて解除が始まったあとは、ローカルには戻せますが Twitter のブックマークは元に戻りません。ダッシュボードを閉じても、2 秒待ちと解除キューは background 側に残ります。

## できること

- ブックマークページからのバッチ収集（100件単位）
- 未整理 1 件ずつのキーボード選別（次件の先読み）
- フォルダ付け（数字キー、前回フォルダの記憶）
- 画像プレビュー（URL 参照。ファイルは持たない）
- 保存済み一覧（フォルダフィルタ）
- 元ポストをブラウザタブで開く
- 保存 / 削除 / スキップの Undo
- JSON でのエクスポート / インポート
- Twitter 本体のブックマーク解除（裏タブを **1 件ずつ** 直列処理。キューは永続化）

## 権限

| 権限 | 理由 |
|---|---|
| `storage` / `unlimitedStorage` | フォルダの記憶と、大量ブックマークの IndexedDB |
| `host_permissions`（x.com / twitter.com） | ブックマークページでの収集と、解除時のボタン操作 |

Twitter は SPA のため、ブックマークへ遷移しても content script が残るよう `https://x.com/*` にマッチさせています。オーバーレイが出るのはブックマークページだけです。

## 自分でビルドする場合

Node.js が入っている必要があります。

```bash
npm install
npm run build
```

できた `dist` フォルダを、上記の「パッケージ化されていない拡張機能を読み込む」で指定します。コードを変えたあとは再ビルドし、拡張機能の画面で再読み込みしてください。

テストは `npm test`（Vitest）で実行します。push と PR では GitHub Actions がテストとビルドを走らせます。

### リリース

`package.json` の `version` を上げてコミットし、同じ番号のタグを push します。

```bash
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions がビルドし、`dist` を zip にして Releases に添付します。タグと `version` が食い違っているとリリースは失敗します。

## アーキテクチャ

Twitter のページ（`x.com` / `twitter.com`）と拡張の IndexedDB はオリジンが違うため、**DB 操作はすべて `background.ts` 経由** です。

```
x.com / i/history     dashboard (index.html)
  content.ts              dashboard.ts
        \                  /
         chrome.runtime.sendMessage
                    |
              background.ts  ← Dexie / IndexedDB
```

| ファイル | 役割 |
|---|---|
| `src/content.ts` | 収集オーバーレイ、DOM からポスト解析、解除クリック |
| `src/dashboard.ts` | 選別 UI、保存済み一覧、Undo、キー操作 |
| `src/background.ts` | DB の読み書き、解除キュー、ダッシュボード起動 |
| `src/db.ts` | `BookmarkPost` 型と Dexie スキーマ |
| `src/messages.ts` | content / dashboard / background のメッセージ型 |
| `src/normalize.ts` | 受け取ったポスト・インポートデータの検証と整形 |
| `src/tweet-dom.ts` | content 用の DOM ヘルパー（本文抽出、ページ判定） |
| `src/urls.ts` | URL の検証 |
| `src/constants.ts` | 既定フォルダ名 |
| `public/manifest.json` | MV3 マニフェスト（`version` はビルド時に `package.json` から入る） |
| `public/content-loader.js` | content script から `assets/content.js` を動的 import |
| `index.html` | ダッシュボード |

ビルドは Vite のマルチページ構成（`vite.config.ts`）です。出力は `dist/`。

## データ

`BookmarkPost`（`src/db.ts`）:

| フィールド | 内容 |
|---|---|
| `id` | ツイート ID |
| `url` | 元ポスト URL |
| `author` | 表示名など |
| `text` | 本文 |
| `images` | 画像 URL の配列（Blob ではない） |
| `folder` | フォルダ名（初期値は `未分類`） |
| `status` | `unprocessed` / `kept` / `discarded` |
| `savedAt` | 収集日時（ISO 文字列） |
| `postedAt` | 元ポストの投稿日時（ISO 文字列。古いデータには無い） |
| `linkCard` | リンクカード（URL・タイトル・ドメイン・画像） |

## ブックマーク解除の動き

1. `←` でローカルを `discarded` にする
2. background が 2 秒待って Undo されなければ解除キューへ（キューは `chrome.storage` に保存）
3. background が裏タブを 1 つだけ開き、そのタブだけ解除を許可するフラグを session に書く
4. content script がフラグと一致するポストページでのみ `removeBookmark` をクリックし、ボタンが `bookmark` に戻るまで待ってから完了を報告する
5. background がタブを閉じる。失敗・タイムアウト（25 秒）でもタブは閉じる
6. 失敗したら 5 秒後に再試行し、3 回失敗すると「解除失敗」として記録する。ダッシュボードのヘッダーに件数が出て、押すと再試行する（Undo 済みのポストは除外）

連打してもタブが同時に大量オープンしないようにしてあります。Service Worker が再起動しても、未処理のキューは再開します。