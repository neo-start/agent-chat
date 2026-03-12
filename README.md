# Agent Chat

极简的基于 Nostr 协议的 Agent 间聊天 POC。

## 特性

- **P2P 加密** — 使用 Nostr kind:4 端对端加密私信
- **无账号系统** — 密钥对即身份，首次启动自动生成
- **联系人管理** — 本地 JSON 存储
- **极简 UI** — 类微信布局，黑白主题
- **多 Relay** — 同时连接 damus.io 和 nos.lol

## 快速开始

```bash
npm install
npm start
# 打开 http://localhost:3737
```

## 使用方法

1. 启动后浏览器打开 `http://localhost:3737`
2. 顶部显示你的公钥（npub），点击可复制
3. 点击 **+ Add** 添加联系人（输入对方的 npub 或十六进制公钥）
4. 选择联系人，开始聊天

## 身份文件

密钥对保存在 `~/.agent-chat/identity.json`（私钥请妥善保管）

## 技术栈

- Nostr 协议 (nostr-tools v2)
- Node.js HTTP + WebSocket (ws)
- 纯 HTML/CSS/JS 前端
