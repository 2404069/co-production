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
// freeルームのcontentは描画履歴 (history: []), それ以外はテキスト (content: '')
const rooms = {
    free: { content: { history: [] }, cursors: new Map(), clients: new Set() },
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
        const filePath = path.join(DATA_DIR, `${room}.json`);
        if (!fs.existsSync(filePath)) {
            // 初期データでファイルを作成
            fs.writeFileSync(filePath, JSON.stringify({ content: INITIAL_CONTENT[room] }), 'utf8');
        } else {
            // 既存ファイルを読み込み、roomsオブジェクトを初期化
            try {
                const data = fs.readFileSync(filePath, 'utf8');
                rooms[room].content = JSON.parse(data).content;
            } catch (e) {
                console.error(`Error reading ${room}.json, initializing with default.`, e);
                rooms[room].content = INITIAL_CONTENT[room];
                fs.writeFileSync(filePath, JSON.stringify({ content: INITIAL_CONTENT[room] }), 'utf8');
            }
        }
    });
    
    // freeルームの描画履歴を初期化または読み込み
    const freeFilePath = path.join(DATA_DIR, 'free.json');
    if (fs.existsSync(freeFilePath)) {
        try {
            const data = fs.readFileSync(freeFilePath, 'utf8');
            rooms.free.content = JSON.parse(data).content;
        } catch (e) {
            console.error(`Error reading free.json, initializing with default.`, e);
            rooms.free.content = { history: [] };
            fs.writeFileSync(freeFilePath, JSON.stringify({ content: { history: [] } }), 'utf8');
        }
    } else {
        // free.jsonがなければ、空の履歴でファイルを作成
        fs.writeFileSync(freeFilePath, JSON.stringify({ content: { history: [] } }), 'utf8');
    }
}

// --- 2. Expressサーバー設定 ---
const app = express();
const server = http.createServer(app);

// ミドルウェア
app.use(express.json()); // JSONペイロードを解析
// ★★★ index.html, published.html などの静的ファイルを配信する設定 ★★★
// (この設定により、index.html や published.html へのアクセスが可能になります)
app.use(express.static(__dirname)); 

// --- 3. APIエンドポイント ---

// ✅ 修正点: /api/content/:room でコンテンツを取得するAPIの追加
// クライアントで発生していた 404 (Not Found) エラーを解消します。
app.get('/api/content/:room', (req, res) => {
    const room = req.params.room;
    
    // ルーム名が存在しない場合は404
    if (!rooms[room]) {
        return res.status(404).json({ error: 'Room not found.' });
    }
    
    try {
        let content;
        const filePath = path.join(DATA_DIR, `${room}.json`);
        
        // ファイルが存在する場合は読み込む
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            content = JSON.parse(data).content;
        } else {
            // ファイルがない場合は、初期化時のroomsオブジェクトの内容を返す
            content = rooms[room].content; 
        }

        // 成功レスポンス
        res.json({ content: content });
    } catch (error) {
        console.error(`Error loading content for ${room}:`, error);
        // サーバー内部エラー
        res.status(500).json({ error: 'Failed to load content.' });
    }
});


// /api/publish で作品を公開するAPI (既存コードに基づき再構成)
app.post('/api/publish', (req, res) => {
    const { title, room, content, content_type, nickname } = req.body;
    
    if (!title || !room || !content || !content_type || !nickname) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    const publishedWork = {
        title,
        room,
        content,
        content_type,
        nickname,
        published_at: new Date().toISOString()
    };
    
    const PUBLISHED_FILE = path.join(DATA_DIR, 'published_works.json');
    let works = [];
    
    try {
        // 既存の作品一覧を読み込み
        if (fs.existsSync(PUBLISHED_FILE)) {
            const data = fs.readFileSync(PUBLISHED_FILE, 'utf8');
            works = JSON.parse(data);
        }
        
        // 新しい作品を追加して保存
        works.push(publishedWork);
        // JSONファイルを整形して保存
        fs.writeFileSync(PUBLISHED_FILE, JSON.stringify(works, null, 2), 'utf8');
        
        res.status(200).json({ message: 'Work published successfully.' });
    } catch (error) {
        console.error('Error publishing work:', error);
        res.status(500).json({ error: 'Failed to publish work.' });
    }
});

// /api/works で公開作品一覧を取得するAPI (published.htmlから呼ばれることを想定し追加)
app.get('/api/works', (req, res) => {
    const PUBLISHED_FILE = path.join(DATA_DIR, 'published_works.json');
    try {
        if (fs.existsSync(PUBLISHED_FILE)) {
            const data = fs.readFileSync(PUBLISHED_FILE, 'utf8');
            const works = JSON.parse(data);
            res.json(works);
        } else {
            res.json([]); // ファイルがない場合は空の配列を返す
        }
    } catch (error) {
        console.error('Error reading published works:', error);
        res.status(500).json({ error: 'Failed to load published works.' });
    }
});


// --- 4. WebSocketサーバー設定 ---

const wss = new WebSocket.Server({ server });
const clients = new Map(); // クライアントIDとクライアント情報を紐づける (未使用だが構造として残す)

// ルーム内の全クライアントにメッセージをブロードキャスト
function broadcast(room, data) {
    if (rooms[room]) {
        const message = JSON.stringify(data);
        rooms[room].clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}

// データの永続化
function saveRoomContent(room) {
    const filePath = path.join(DATA_DIR, `${room}.json`);
    try {
        fs.writeFileSync(filePath, JSON.stringify({ content: rooms[room].content }), 'utf8');
    } catch (error) {
        console.error(`Error saving ${room} content:`, error);
    }
}


wss.on('connection', (ws) => {
    ws.id = Math.random().toString(36).substring(2, 9);
    ws.clientInfo = {}; 

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, room, nickname } = data;
            
            if (type === 'join' && room && nickname) {
                if (ws.clientInfo.room && rooms[ws.clientInfo.room]) {
                    rooms[ws.clientInfo.room].clients.delete(ws);
                }

                ws.clientInfo.room = room;
                ws.clientInfo.nickname = nickname;
                
                rooms[room].clients.add(ws);
                ws.nickname = nickname; 

                const usersInRoom = Array.from(rooms[room].clients).map(c => c.nickname);
                broadcast(room, { type: 'user_list_update', users: usersInRoom });
            }

            if (!ws.clientInfo.room) return; 

            switch (type) {
                case 'draw':
                    if (room === 'free') {
                        const { x0, y0, x1, y1, color, lineWidth, isErase } = data;
                        rooms.free.content.history.push({ x0, y0, x1, y1, color, lineWidth, isErase });
                        saveRoomContent('free');
                        broadcast(room, data);
                    }
                    break;
                case 'text_update':
                    if (room === 'novel' || room === 'music') {
                        rooms[room].content = data.content;
                        saveRoomContent(room);
                        broadcast(room, data);
                    }
                    break;
                case 'clear':
                    if (room === 'free') {
                        rooms.free.content.history = [];
                        saveRoomContent('free');
                        broadcast(room, data);
                    }
                    break;
                case 'undo':
                case 'redo':
                    if (room === 'free') {
                        const newHistoryIndex = data.historyIndex;
                        broadcast(room, { 
                            type: 'undo_redo', 
                            room: 'free',
                            history: rooms.free.content.history, 
                            historyIndex: newHistoryIndex 
                        });
                    }
                    break;
                case 'cursor_update':
                    broadcast(room, {
                        type: 'cursor_update',
                        room: room,
                        nickname: ws.nickname,
                        isText: data.isText,
                        position: data.position
                    });
                    break;
            }

        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        const clientInfo = ws.clientInfo;
        if (clientInfo && clientInfo.room) {
            const { room, nickname } = clientInfo;
            
            rooms[room].clients.delete(ws);
            
            const usersInRoom = Array.from(rooms[room].clients).map(c => c.nickname);
            broadcast(room, { type: 'user_list_update', users: usersInRoom });
            
            // 離脱したユーザーのカーソルを非表示にするメッセージもブロードキャスト
            broadcast(room, { 
                type: 'cursor_update', 
                room, 
                nickname, 
                isText: true, 
                position: -1 
            });
            broadcast(room, { 
                type: 'cursor_update', 
                room, 
                nickname, 
                isText: false, 
                position: {x: -1, y: -1}
            });
        }
        clients.delete(ws.id);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

// --- 5. サーバー起動 ---
initializeDataFiles(); 

server.listen(PORT, HOST, () => {
    console.log(`\n==============================================`);
    console.log(`  Server is running on http://${HOST}:${PORT}`);
    console.log(`==============================================`);
});