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

// ルームの状態を保持するオブジェクト (freeのcontentは描画履歴の配列を持つオブジェクト)
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
    
    // データの初期化または読み込み
    Object.keys(rooms).forEach(room => {
        const filePath = path.join(DATA_DIR, `${room}.json`);
        
        if (!fs.existsSync(filePath)) {
            const content = room === 'free' ? { history: [] } : INITIAL_CONTENT[room];
            fs.writeFileSync(filePath, JSON.stringify({ content }), 'utf8');
            rooms[room].content = content;
        } else {
            try {
                const data = fs.readFileSync(filePath, 'utf8');
                rooms[room].content = JSON.parse(data).content;
            } catch (e) {
                console.error(`Error reading ${room}.json, initializing with default.`, e);
                const content = room === 'free' ? { history: [] } : INITIAL_CONTENT[room];
                rooms[room].content = content;
            }
        }
    });
}

// --- 2. Expressサーバー設定 ---
const app = express();
const server = http.createServer(app);

// ミドルウェア
app.use(express.json()); 
app.use(express.static(__dirname)); 

// --- 3. APIエンドポイント (コンテンツ読み込み) ---

// /api/content/:room でコンテンツを取得するAPI
app.get('/api/content/:room', (req, res) => {
    const room = req.params.room;
    
    if (!rooms[room]) {
        return res.status(404).json({ error: 'Room not found.' });
    }
    
    try {
        // filesytemから直接最新データを読み込む
        const filePath = path.join(DATA_DIR, `${room}.json`);
        let content = rooms[room].content; // メモリ上の初期値

        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            content = JSON.parse(data).content;
        }

        res.json({ content: content });
    } catch (error) {
        console.error(`Error loading content for ${room}:`, error);
        res.status(500).json({ error: 'Failed to load content.' });
    }
});


// /api/publish で作品を公開するAPI (変更なし)
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
        if (fs.existsSync(PUBLISHED_FILE)) {
            const data = fs.readFileSync(PUBLISHED_FILE, 'utf8');
            works = JSON.parse(data);
        }
        
        works.push(publishedWork);
        fs.writeFileSync(PUBLISHED_FILE, JSON.stringify(works, null, 2), 'utf8');
        
        res.status(200).json({ message: 'Work published successfully.' });
    } catch (error) {
        console.error('Error publishing work:', error);
        res.status(500).json({ error: 'Failed to publish work.' });
    }
});

// /api/works で公開作品一覧を取得するAPI (変更なし)
app.get('/api/works', (req, res) => {
    const PUBLISHED_FILE = path.join(DATA_DIR, 'published_works.json');
    try {
        if (fs.existsSync(PUBLISHED_FILE)) {
            const data = fs.readFileSync(PUBLISHED_FILE, 'utf8');
            const works = JSON.parse(data);
            res.json(works);
        } else {
            res.json([]); 
        }
    } catch (error) {
        console.error('Error reading published works:', error);
        res.status(500).json({ error: 'Failed to load published works.' });
    }
});


// --- 4. WebSocketサーバー設定 ---

const wss = new WebSocket.Server({ server });

// ルーム内の全クライアントにメッセージをブロードキャスト
function broadcast(room, data) {
    if (rooms[room]) {
        const message = JSON.stringify(data);
        // ★デバッグ用ログ: 送信がどこまで行っているか確認できます★
        // console.log(`Broadcasting [${data.type}] in ${room} to ${rooms[room].clients.size} clients.`); 
        
        rooms[room].clients.forEach(client => {
            // ws.clientInfo.nicknameがない場合は弾く（接続直後などでデータが不完全な場合）
            if (client.readyState === WebSocket.OPEN && client.clientInfo && client.clientInfo.room) {
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
                // 以前のルームから離脱させる処理
                if (ws.clientInfo.room && rooms[ws.clientInfo.room]) {
                    rooms[ws.clientInfo.room].clients.delete(ws);
                }

                ws.clientInfo.room = room;
                ws.clientInfo.nickname = nickname;
                ws.nickname = nickname; // ニックネームをwsオブジェクトにも保持

                // 新しいルームに参加
                rooms[room].clients.add(ws); 

                // ユーザーリスト更新をブロードキャスト
                const usersInRoom = Array.from(rooms[room].clients).map(c => c.nickname);
                broadcast(room, { type: 'user_list_update', users: usersInRoom });
            }

            if (!ws.clientInfo.room) return; 

            switch (type) {
                case 'draw':
                    if (room === 'free') {
                        // 描画履歴を更新・永続化
                        const { x0, y0, x1, y1, color, lineWidth, isErase } = data;
                        rooms.free.content.history.push({ x0, y0, x1, y1, color, lineWidth, isErase });
                        saveRoomContent('free'); 
                        // 他のクライアントにブロードキャスト（自分自身にも送ってローカル描画との一貫性を保つ）
                        broadcast(room, data);
                    }
                    break;
                case 'text_update':
                    if (room === 'novel' || room === 'music') {
                        rooms[room].content = data.content;
                        saveRoomContent(room);
                        // 他のクライアントにブロードキャスト
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
                        // クライアント側で historyIndex が操作されたことを通知
                        const newHistoryIndex = data.historyIndex;
                        
                        // 履歴全体と新しいインデックスをブロードキャストし、クライアント側で再描画させる
                        broadcast(room, { 
                            type: 'undo_redo', 
                            room: 'free',
                            history: rooms.free.content.history, 
                            historyIndex: newHistoryIndex 
                        });
                        // undo/redo はデータ永続化（ファイル保存）は不要。描画データ自体は 'draw' 時に保存済み。
                    }
                    break;
                case 'cursor_update':
                    // カーソル位置の変更は自分以外にブロードキャスト
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
            
            // ユーザーリスト更新をブロードキャスト
            const usersInRoom = Array.from(rooms[room].clients).map(c => c.nickname);
            broadcast(room, { type: 'user_list_update', users: usersInRoom });
            
            // 離脱したユーザーのカーソルを非表示にするメッセージもブロードキャスト
            // (cursor_update は nickname が異なることを前提としてクライアント側で処理される)
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