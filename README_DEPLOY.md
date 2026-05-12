# 電解質益智擂台 — 線上多人版部署說明

本專案是一個以 Node.js + Express + WebSocket (`ws`) 搭建的多人線上即時問答遊戲。
玩家可以建立「房間」並以「房間密碼」邀請朋友加入，最多 3 人同房對戰，共 20 題、每題答對 +5 分、答錯 +0 分，結束後顯示頒獎台。

---

## 一、檔案結構

```
multiplayer-electrolyte-quiz/
├── server.js               # Node.js + Express + ws 後端（含房間/計分/廣播邏輯）
├── questions.js            # 後端題庫載入模組（從 questions-source.js 取得 50 題）
├── questions-source.js     # 50 題繁體中文題庫（共用：前端 / 後端皆可使用）
├── package.json            # 依賴：express, ws
├── public/
│   ├── index.html          # 前端入口
│   ├── style.css           # 卡通舞台 + 黑板樣式
│   └── app.js              # 前端 WebSocket 連線、UI 狀態管理
└── README_DEPLOY.md        # 本說明檔
```

---

## 二、在本機執行

需要 Node.js 18 以上版本。

```bash
# 1) 安裝依賴
npm install

# 2) 啟動伺服器（預設 port 5000）
node server.js
```

啟動後在瀏覽器開啟：

```
http://localhost:5000/
```

即可建立房間或輸入房間密碼加入遊戲。

如想改變 port：

```bash
PORT=8080 node server.js
```

伺服器會讀取 `process.env.PORT`；若未設定則使用 `5000`。

---

## 三、部署到 Render / Railway / 任何 Node 主機

伺服器在以下幾個關鍵點都已經為雲端平台做好準備：

1. `server.js` 使用 `parseInt(process.env.PORT || '5000', 10)`，平台會自動注入 `PORT`。
2. `server.listen(PORT, '0.0.0.0', ...)`，可被外部存取。
3. 前端 `public/app.js` 的 WebSocket 連線 URL 為「同源動態組裝」：
   - 若頁面為 `https://...`，自動使用 `wss://同網域/ws`
   - 若為 `http://...`，使用 `ws://同網域/ws`
   - 因此**不需要手動修改 URL** 即可在 Render/Railway 等同源部署環境下運作。

### Render 部署步驟

1. 將整個 `multiplayer-electrolyte-quiz/` 推上 GitHub。
2. 在 Render Dashboard 點 **New → Web Service** → 連接 repo。
3. 設定：
   - **Environment**：`Node`
   - **Build Command**：`npm install`
   - **Start Command**：`node server.js`
   - **Instance Type**：Free / Starter 皆可
4. Render 會自動指派 `PORT`，伺服器會讀取並監聽。
5. 部署完成後即可從 `https://<your-app>.onrender.com/` 進入遊戲。

### Railway 部署步驟

1. 將專案推到 GitHub。
2. Railway → **New Project → Deploy from GitHub Repo**。
3. Railway 會偵測到 `package.json`，自動執行 `npm install` 並使用 `npm start`（即 `node server.js`）。
4. 在 Settings → Networking 開啟 Public Domain，取得對外網址即可使用。

### Heroku / 其它平台

只要平台支援 Node.js 並能注入 `PORT` 環境變數，本專案即可直接部署，**毋須額外設定**。

---

## 四、可選的環境變數

| 變數                  | 預設值  | 說明                  |
| --------------------- | ------- | --------------------- |
| `PORT`                | `5000`  | 伺服器監聽 port       |
| `QUESTIONS_PER_MATCH` | `20`    | 每場題數              |
| `QUESTION_DURATION_MS`| `20000` | 每題作答時間（毫秒）  |
| `REVEAL_DURATION_MS`  | `6000`  | 揭曉答案顯示時間（毫秒） |

---

## 五、遊戲規則摘要

- 主題：**電解質益智擂台**
- 最多 **3 位玩家** 同房對戰
- 房主建立房間時系統產生 **房間密碼**，分享給朋友加入
- 共 **20 題**（從 50 題題庫隨機抽出）
- 答對 **+5 分**，答錯或逾時 **+0 分**
- 結束顯示 **頒獎台**（金 / 銀 / 銅）

---

## 六、疑難排解

- **連線不到 WebSocket**：請確認部署平台未阻擋 WebSocket（Render / Railway 預設支援）；也可在瀏覽器 DevTools → Network → WS 觀察握手回應。
- **看到 `[quiz] listening on http://0.0.0.0:XXXX` 但外網無法訪問**：通常是平台 Networking 未開啟對外網域，請至 Render/Railway 後台確認。
- **題庫想擴充**：直接編輯 `questions-source.js`，新增物件即可，前端 / 後端會自動共用。

---

祝部署順利！⚡
