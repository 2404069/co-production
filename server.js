const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// --- サーバー設定 ---
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; 

// --- データ管理 ---
const DATA_DIR = path.join(__dirname, 'data');
const INITIAL_CONTENT = {
    novel: 'ここに小説を共同で入力してください。\n\n他の参加者が入力するとリアルタイムで反映されます。',
    music: '[歌詞/アイデア]:\nここに音楽の歌詞やアイデアを共同で入力してください。',
};

// ルームの状態を保持するオブジェクト
const rooms = {
    // freeのcontentは描画履歴の配列を持つオブジェクト { history: [] }
    free: { content: { history: [] }, cursors: new Map(), clients: new Set() },
    // novel/musicのcontentは文字列
    novel: { content: INITIAL_CONTENT.novel, cursors: new Map(), clients: new Set() },
    music: { content: INITIAL_CONTENT.music, cursors: new Map(), clients: new Set() },
};

// --- 1. 初期ファイルシステム設定 ---
function initializeDataFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR);
    }
    
    // データの初期化または読み込み
    Object.keys(rooms).forEach(room => {
        const filePath = path.join(DATA_DIR, room === 'free' ? 'free.json' : `${room}.txt`);
        
        if (!fs.existsSync(filePath)) {
            const content = room === 'free' ? { history: [] } : INITIAL_CONTENT[room];
            const dataToWrite = room === 'free' ? JSON.stringify(content) : content;
            fs.writeFileSync(filePath, dataToWrite, 'utf8');
            rooms[room].content = content;
        } else {
            try {
                const data = fs.readFileSync(filePath, 'utf8');
                rooms[room].content = room === 'free' ? JSON.parse(data) : data;
            } catch (e) {
                console.error(`Error reading ${room} data, initializing with default.`, e);
                const content = room === 'free' ? { history: [] } : INITIAL_CONTENT[room];
                rooms[room].content = content;
            }
        }
    });
}

// データをファイルに書き込む汎用関数
function saveContentToFile(room, content) {
    const filePath = path.join(DATA_DIR, room === 'free' ? 'free.json' : `${room}.txt`);
    const dataToWrite = room === 'free' ? JSON.stringify(content) : content;
    
    fs.writeFile(filePath, dataToWrite, 'utf8', (err) => {
        if (err) console.error(`Failed to save ${room} content:`, err);
    });
}

// --- 2. HTTPサーバー設定 (Express) ---
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '50mb' })); 
app.use(express.static(__dirname)); 

// API: 初期コンテンツの取得
app.get('/api/content/:room', (req, res) => {
    const room = req.params.room;
    if (rooms[room]) {
        // ファイルから最新のコンテンツを読み込み直して返す (永続化の確認)
        const filePath = path.join(DATA_DIR, room === 'free' ? 'free.json' : `${room}.txt`);
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const content = room === 'free' ? JSON.parse(data) : data;
            res.json({ content: content });
        } catch (e) {
            console.error(`Error reading data from file system: ${room}`, e);
            res.json({ content: rooms[room].content }); // メモリ上のものをフォールバック
        }
    } else {
        res.status(404).send('Room not found');
    }
});

// API: 作品公開
app.post('/api/publish', (req, res) => {
    const { title, room, content, content_type, nickname } = req.body;
    const publishFilePath = path.join(__dirname, 'published_works.json');
    
    const newWork = {
        id: Date.now(),
        title: title || 'タイトルなし',
        room: room,
        author: nickname || '匿名',
        content: content,
        content_type: content_type,
        published_at: new Date().toISOString()
    };
    
    let works = [];
    if (fs.existsSync(publishFilePath)) {
        try {
            works = JSON.parse(fs.readFileSync(publishFilePath, 'utf8'));
        } catch (e) {
            console.error('Failed to parse published_works.json:', e);
        }
    }
    
    works.unshift(newWork);
    
    fs.writeFile(publishFilePath, JSON.stringify(works, null, 2), 'utf8', (err) => {
        if (err) {
            console.error('Failed to save published work:', err);
            return res.status(500).send('Failed to save published work');
        }
        res.status(200).send('Work published successfully');
    });
});

// API: 公開作品一覧の取得
app.get('/api/works', (req, res) => {
    const publishFilePath = path.join(__dirname, 'published_works.json');
    if (fs.existsSync(publishFilePath)) {
        try {
            const works = JSON.parse(fs.readFileSync(publishFilePath, 'utf8'));
            res.json(works);
        } catch (e) {
            res.status(500).json([]);
        }
    } else {
        res.json([]);
    }
});


// --- 3. WebSocketサーバー設定 ---
const wss = new WebSocket.Server({ server });
const clients = new Map();

// 全員または特定のルームにメッセージをブロードキャストする
function broadcast(room, data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        // クライアントがオープン状態で、かつ同じルームにいる場合に送信
        if (client.readyState === WebSocket.OPEN && client.room === room) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    ws.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
    
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        switch (data.type) {
            case 'join':
                // 以前のルームからクライアントとカーソル情報を削除
                if (ws.room) {
                    rooms[ws.room].clients.delete(ws);
                    rooms[ws.room].cursors.delete(ws.nickname);
                }

                // 新しいルーム情報とニックネームを保存
                ws.room = data.room;
                ws.nickname = data.nickname;
                
                // 新しいルームにクライアントを追加
                if (rooms[data.room]) {
                    rooms[data.room].clients.add(ws);
                }
                
                // 参加メッセージをブロードキャスト
                const usersInRoom = Array.from(rooms[data.room].clients).map(c => c.nickname);
                broadcast(data.room, { type: 'joined', users: usersInRoom });
                
                // 既存のカーソル情報を送信（新規参加者向け）
                rooms[data.room].cursors.forEach((cursorPos, nickname) => {
                    ws.send(JSON.stringify({
                        type: 'cursor_update',
                        room: data.room,
                        nickname: nickname,
                        isText: cursorPos.isText,
                        position: cursorPos.position,
                        tool: cursorPos.tool,
                        penColor: cursorPos.penColor,
                        penWidth: cursorPos.penWidth
                    }));
                });
                break;
                
            case 'content_update':
                if (data.room === 'free') {
                    // 描画イベントの処理
                    if (data.line) {
                        const freeContent = rooms.free.content;
                        
                        // 描画履歴を更新（履歴に追加）
                        freeContent.history.push({ 
                            x0: data.line.x0, y0: data.line.y0, x1: data.line.x1, y1: data.line.y1, 
                            color: data.line.color, width: data.line.width, tool: data.line.tool
                        });
                        
                        // 履歴が長くなりすぎるのを防ぐ
                        if (freeContent.history.length > 2000) {
                            freeContent.history.shift();
                        }
                        saveContentToFile('free', freeContent);
                        
                        // 他のクライアントにブロードキャスト
                        broadcast(data.room, { type: 'draw', room: data.room, ...data.line });
                    }
                    
                } else if (data.room === 'novel' || data.room === 'music') {
                    // テキストデータの処理
                    rooms[data.room].content = data.content;
                    broadcast(data.room, data);
                    saveContentToFile(data.room, data.content);
                }
                break;

            case 'clear':
                // 全消去をブロードキャストし、サーバーデータとファイルを更新
                rooms.free.content.history = []; // 履歴をクリア
                broadcast('free', { type: 'clear', room: 'free' });
                saveContentToFile('free', rooms.free.content);
                break;
                
            case 'undo':
            case 'redo':
                // クライアント側で履歴インデックスが操作されたことを通知
                // サーバーは履歴全体を送信し、クライアント側で再描画させる
                if (data.room === 'free') {
                    broadcast('free', { 
                        type: 'undo_redo', 
                        room: 'free', 
                        history: rooms.free.content.history,
                        historyIndex: data.historyIndex 
                    });
                }
                break;

            case 'cursor_update':
                // カーソル情報を更新し、ブロードキャスト
                if (rooms[data.room]) {
                    rooms[data.room].cursors.set(ws.nickname, { 
                        isText: data.isText, 
                        position: data.position,
                        tool: data.tool,
                        penColor: data.penColor,
                        penWidth: data.penWidth
                    });
                    
                    broadcast(data.room, data);
                }
                break;
        }
    });
    
    ws.on('close', () => {
        const room = ws.room;
        const nickname = ws.nickname;
        
        if (room && nickname) {
            rooms[room].clients.delete(ws);
            rooms[room].cursors.delete(nickname);
            
            // ルーム離脱をブロードキャスト
            const usersInRoom = Array.from(rooms[room].clients).map(c => c.nickname);
            broadcast(room, { type: 'user_list_update', users: usersInRoom });
            
            // 離脱したユーザーのカーソルを非表示にするメッセージもブロードキャスト
            broadcast(room, { 
                type: 'cursor_update', room, nickname, isText: true, position: -1 
            });
            broadcast(room, { 
                type: 'cursor_update', room, nickname, isText: false, position: {x: -1, y: -1}
            });
        }
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

// --- 4. サーバー起動 ---
initializeDataFiles(); 

server.listen(PORT, HOST, () => {
    console.log(`\n=================================================`);
    console.log(`Server running at http://${HOST}:${PORT}`);
    console.log(`=================================================\n`);
});