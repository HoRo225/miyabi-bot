# AGENTS.md

- 永遠使用繁體中文回覆。
- 每回合使用 ponytail skill，採最簡單可靠的做法。
- 本 repo 是唯一 source of truth，保存 bot source、Dockerfile、Compose、部署腳本、測試與 Cloud agent 設定。
- 不得提交 production secrets、.env、資料庫、備份、9router keys 或 SSH key。
- 所有變更走分支與 PR；main 必須通過 source-ci，使用 squash merge。
- Production 位於 `/srv/horo-discord-bot`，保留完整 source checkout；host 不得直接安裝或執行 Node/npm。
- 依賴安裝、測試、建置與 runtime 一律透過 Docker／Docker Compose。
- 正式部署只能在 main 同步且 worktree 乾淨時執行 `sh ops/deploy.sh`；GitHub 不自動部署，也不發布 GHCR image。
- 需要理解架構或跨檔關係時，先使用遠端 Codebase Memory project `srv-horo-discord-bot`；它只索引 server 上的 production `main`。
- 未合併 branch 的檔案內容以當前 checkout 為準，不建立 Cloud／本機 Codebase Memory 索引。
- 成功部署新 main 後，在 server 以既有 Codebase Memory v0.9.0 重新索引 `/srv/horo-discord-bot`；索引失敗不得觸發 bot 或資料庫 rollback。
- 除非使用者明確要求，不新增 Discord slash command。
- Discord 時間預設使用短日期、短時間、相對時間組合。
