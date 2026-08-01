# AGENTS.md

- 永遠使用繁體中文回覆。
- 每回合使用 ponytail skill，採最簡單可靠的做法。
- 本 repo 只保存 bot 原始碼、Docker build 與測試；不得提交 production secrets、.env、資料庫或 SSH key。
- 所有變更走分支與 PR；main 必須通過 source-ci。
- 需要理解架構或跨檔關係時，先使用 Codebase Memory；Cloud session 開始時索引目前 checkout，修改後重建，session 結束不保留索引。
- 測試與建置使用 Docker；production host 不直接執行 Node 或 npm。
- 除非使用者明確要求，不新增 Discord slash command。
- Discord 時間預設使用短日期、短時間、相對時間組合。
