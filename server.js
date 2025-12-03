const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// --- サーバー設定 ---
const PORT = process.env.PORT || 3000;
// ★重要★ 外部からの接続を許可するため、HOSTを '0.0.0.0' に設定
const HOST = '0.0.0.0'; 

// --- データ管理 ---
const DATA_DIR = path.join(__dirname, 'data');
const INITIAL_CONTENT = {
    novel: 'ここに小説を共同で入力してください。\n\n他の参加者が入力するとリアルタイムで反映されます。',
    music: '[歌詞/アイデア]:\nここに音楽の歌詞やアイデアを共同で入力してください。',
};

// ルームの状態を保持するオブジェクト
const rooms = {
    free: { content: '', cursors: new Map(), clients: new Set() },
    novel: { content: INITIAL_CONTENT.novel, cursors: new Map(), clients: new Set() },
    music: { content: INITIAL_CONTENT.music, cursors: new Map(), clients: new Set() },
};

// --- 1. 初期ファイルシステム設定 ---
function initializeDataFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR);
    }
    
    // 描画データ以外のテキストデータを初期化または読み込み
    ['novel', 'music'].forEach(room => {
        const filePath = path.join(DATA_DIR, `${room}_data.txt`);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, rooms[room].content, 'utf8');
        } else {
            // 既存データがあれば読み込む
            const loadedContent = fs.readFileSync(filePath, 'utf8');
            rooms[room].content = loadedContent;
        }
    });

    // 描画データは空ファイルとして存在させる
    const freeFilePath = path.join(DATA_DIR, 'free_data.txt');
    if (!fs.existsSync(freeFilePath)) {
         fs.writeFileSync(freeFilePath, '', 'utf8');
    }
}

// --- 2. Expressサーバー設定 (静的ファイル/API) ---
const app = express();
const server = http.createServer(app);
app.use(express.json()); // JSONボディを解析
app.use(express.static(__dirname)); // 現在のディレクトリを静的ファイルとして公開

// /data/room_data.txt へのリクエストを処理 (クライアントのロード処理で使用)
app.get('/data/:filename', (req, res) => {
    const filePath = path.join(DATA_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Not Found');
    }
});

// API: 一時保存
app.post('/api/save', (req, res) => {
    const { room, content } = req.body;
    if (room && content !== undefined) {
        const filePath = path.join(DATA_DIR, `${room}_data.txt`);
        try {
            fs.writeFileSync(filePath, content, 'utf8');
            rooms[room].content = content; // サーバーメモリも更新
            res.status(200).send('Saved successfully.');
        } catch (e) {
            console.error('Save failed:', e);
            res.status(500).send('Save failed.');
        }
    } else {
        res.status(400).send('Invalid request.');
    }
});

// API: 作品公開
app.post('/api/publish', (req, res) => {
    const { title, room, content, content_type } = req.body;
    const publishFilePath = path.join(__dirname, 'published_works.json');
    
    let works = [];
    if (fs.existsSync(publishFilePath)) {
        works = JSON.parse(fs.readFileSync(publishFilePath, 'utf8'));
    }

    const newWork = {
        id: Date.now(),
        title,
        room,
        content_type,
        // テキストコンテンツは最初の200文字に制限してスニペットを作成
        snippet: content_type === 'text' ? content.substring(0, 200) + (content.length > 200 ? '...' : '') : 'Binary Content (Image)',
        content, // 全文を保存
        published_at: new Date().toISOString()
    };
    
    works.push(newWork);
    
    try {
        fs.writeFileSync(publishFilePath, JSON.stringify(works, null, 2), 'utf8');
        res.status(200).send('Published successfully.');
    } catch (e) {
        console.error('Publish failed:', e);
        res.status(500).send('Publish failed.');
    }
});


// --- 3. WebSocketサーバー設定 ---
const wss = new WebSocket.Server({ server });

// クライアントを管理するマップ (クライアントID -> { room, nickname })
const clients = new Map();

// 特定のルームの全クライアントにメッセージをブロードキャスト
function broadcast(room, data, excludeClient = null) {
    rooms[room].clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== excludeClient) {
            client.send(JSON.stringify(data));
        }
    });
}

wss.on('connection', (ws) => {
    ws.id = Date.now() + Math.random();
    clients.set(ws.id, { room: null, nickname: 'Unknown' });

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const clientInfo = clients.get(ws.id);
        
        if (data.type === 'join_room') {
            // 既存ルームから離脱
            if (clientInfo.room && rooms[clientInfo.room]) {
                rooms[clientInfo.room].clients.delete(ws);
                rooms[clientInfo.room].cursors.delete(clientInfo.nickname);
            }
            
            // 新しいルームに参加
            clientInfo.room = data.room;
            clientInfo.nickname = data.nickname;
            rooms[data.room].clients.add(ws);

            // 参加者に現在のコンテンツを送信
            ws.send(JSON.stringify({
                type: 'content_update',
                room: data.room,
                content: rooms[data.room].content,
                // musicルームの場合、歌詞とURLを分割して送信
                lyrics: data.room === 'music' ? rooms[data.room].content : null,
                urls: data.room === 'music' ? extractUrls(rooms[data.room].content) : null,
            }));
            
            // 他のクライアントに、新しい参加者のカーソルをすべて送信
            rooms[data.room].cursors.forEach((cursorData, nickname) => {
                if (nickname !== clientInfo.nickname) {
                     ws.send(JSON.stringify({ type: 'cursor_update', room: data.room, nickname, ...cursorData }));
                }
            });

        } else if (data.type === 'content_update') {
            // コンテンツの更新
            const { room } = data;
            if (rooms[room]) {
                // サーバーメモリ上のコンテンツを更新
                rooms[room].content = data.content;
                // 他のクライアントにブロードキャスト
                broadcast(room, data, ws);
            }
        } else if (data.type === 'cursor_update') {
            // カーソル位置の更新
            const { room, nickname, ...cursorData } = data;
            if (rooms[room]) {
                rooms[room].cursors.set(nickname, cursorData);
                // 他のクライアントにブロードキャスト (自身の更新は除外)
                broadcast(room, data, ws);
            }
        }
    });

    ws.on('close', () => {
        const clientInfo = clients.get(ws.id);
        if (clientInfo && clientInfo.room) {
            const { room, nickname } = clientInfo;
            
            // ルームからクライアントとカーソル情報を削除
            if (rooms[room]) {
                rooms[room].clients.delete(ws);
                rooms[room].cursors.delete(nickname);
                
                // 他のクライアントに、このユーザーが離脱したことを通知 (カーソル非表示のため)
                broadcast(room, { 
                    type: 'cursor_update', 
                    room, 
                    nickname, 
                    isText: true, 
                    position: -1 // -1で非表示を指示
                });
                broadcast(room, { 
                    type: 'cursor_update', 
                    room, 
                    nickname, 
                    isText: false, 
                    position: {x: -1, y: -1} // -1で非表示を指示
                });
            }
        }
        clients.delete(ws.id);
    });
    
    // エラーハンドリング
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

// --- ユーティリティ関数 (musicルームのURL抽出用) ---
function extractUrls(data) {
    // 音楽ルームのデータから [URL: ...] の形式のURLを抽出
    const urlRegex = /\[URL: (.*?)\]/g;
    const urls = [];
    let match;
    while ((match = urlRegex.exec(data)) !== null) {
        urls.push(match[1]);
    }
    return urls;
}

// --- 4. サーバー起動 ---
initializeDataFiles(); // 起動前にデータファイルを準備

server.listen(PORT, HOST, () => {
    // 外部公開設定: '0.0.0.0'でリスニングしていることを確認
    console.log(`\n======================================================`);
    console.log(`✅ サーバーが起動しました (公開設定済み)`);
    console.log(`💻 HTTP/API: http://localhost:${PORT}/index.html`);
    console.log(`🌐 WebSocket: ws://${HOST}:${PORT}`);
    console.log(`🚨 注意: 外部からアクセスするには、ファイアウォールでポート ${PORT} を開放する必要があります。`);
    console.log(`======================================================\n`);
});