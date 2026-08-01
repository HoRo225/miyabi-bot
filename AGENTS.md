# AGENTS.md

<INSTRUCTIONS>
1. 回覆語言：一律使用繁體中文。
2. 固定技能：每回合一律使用 [@ponytail](plugin://ponytail@personal)。
3. 權威環境：專案 runtime 以 server `horo@192.168.1.107:/srv/horo-discord-bot` 為準；server 沒有 `AGENTS.md` 時，以本機這份規則約束操作。
4. 本機可做：可以在本機專案資料夾讀取、搜尋、比較與編輯檔案，也可以使用本機專案資料夾內的 SSH key 發起連線。
5. 本機禁做：不得在本機安裝任何依賴、套件或工具；不得在本機執行專案 Docker、Node/npm、git、測試、建置或部署命令。
6. 遠端執行：測試、建置、部署與服務操作都必須先 SSH 到 server，並在 `/srv/horo-discord-bot` 內透過 Docker / Docker Compose 執行。
7. 遠端禁做：不得在 server host 直接安裝或執行 Node/npm 等專案依賴；需要執行程式、安裝套件、產生 build output 或跑測試時，一律放進 Docker。
8. 修改方式：純文字與原始碼可在本機用 patch 修改，也可在 server 以 patch、heredoc 或 server-side editor 修改；保持改動小而集中。
9. 程式變更收尾：程式碼、依賴、Dockerfile、docker-compose.yml、.env 或 runtime 設定變更後，完成可適用的 Docker 測試；測試通過後重建並重開 bot 服務。
10. 文件變更收尾：文件、AGENTS.md 或純說明文字變更不需要重建或重開 bot；只需檢查內容、確認沒有明文密碼，並在 server 執行 `docker compose config --quiet`。
11. 設計原則：所有程式與功能都要低耦合、高內聚；能用簡單可靠的做法，就不要加抽象。
12. 借鑑優先：若 GitHub 上有符合用戶需求且授權相容的現有專案，優先參考該專案的做法；不要重新造輪子。
13. 憑證安全：優先使用 SSH key 登入 server；不得在 repo、文件、指令或 log 中保存或輸出明文密碼、token、secret 或私鑰內容。
14. 權限升級：需要密碼、sudo 密碼或額外權限時，向使用者當次詢問，不得自行猜測或持久化。
15. Discord 時間格式：所有 Discord 訊息與設定頁顯示時間時，預設使用短日期、短時間、相對時間組合，即 `<t:...:d> <t:...:t> (<t:...:R>)`；不要使用 `<t:...:F>`，除非使用者明確要求。
16. DevSpace：DevSpace 服務位於 `/srv/devspace`，以 Docker Compose 專案 `devspace` 執行；不得在 host 直接安裝或執行 devspace/npm/node。
17. DevSpace 存取：DevSpace 預設只綁定 `127.0.0.1:7676`，透過 SSH tunnel 使用；不得未經確認改成對 LAN/Internet 開放。
18. DevSpace 工作區：允許工作區為 `/srv/horo-discord-bot` 與 `/srv/devspace/worktrees`；透過 DevSpace 修改掛載檔案視同 server-side 檔案修改，但專案執行仍須走 Docker。
19. DevSpace runtime 狀態：在 DevSpace shell 內可用 `ssh horo-runtime` 查詢 bot 與 DevSpace 的 Docker Compose 狀態；此 SSH key 受 server forced-command 限制，只能回傳狀態，不得嘗試繞過限制或要求更高權限。
20. DevSpace 完整 SSH：在 DevSpace shell 內可用 `ssh horo-full "<command>"` 以 `horo` 身分在 server 執行完整命令；仍須遵守不得在 host 直接執行 Node/npm 等專案依賴、不得輸出 secrets、測試/建置/部署必須在 `/srv/horo-discord-bot` 透過 Docker / Docker Compose 執行。
</INSTRUCTIONS>
