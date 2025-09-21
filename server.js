const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; // Get URI from environment variables
const DB_NAME = 'scheduleApp';
const COLLECTION_NAME = 'data';
const SINGLETON_DOC_ID = 'singleton_database';
const DEFAULT_PROFILE_NAME = 'default';

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- MongoDB Client Setup ---
let db, collection, client;
let isConnected = false;

async function connectToDb() {
    if (isConnected) return;
    if (!MONGO_URI) {
        console.error("!!! 嚴重錯誤：找不到 MONGO_URI 環境變數。");
        return;
    }
    client = new MongoClient(MONGO_URI, {
        serverApi: {
            version: ServerApiVersion.v1,
            strict: true,
            deprecationErrors: true,
        }
    });
    try {
        await client.connect();
        db = client.db(DB_NAME);
        collection = db.collection(COLLECTION_NAME);
        await client.db("admin").command({ ping: 1 });
        console.log("成功連線到 MongoDB！");
        isConnected = true;
    } catch (e) {
        console.error("!!! 連線到 MongoDB 失敗:", e);
        isConnected = false;
    }
}

// --- Database Helper Functions ---
const getDbState = async () => {
    if (!isConnected) return null;
    let state = await collection.findOne({ _id: SINGLETON_DOC_ID });
    if (!state) {
        state = {
            _id: SINGLETON_DOC_ID,
            activeProfile: DEFAULT_PROFILE_NAME,
            profiles: {
                [DEFAULT_PROFILE_NAME]: {
                    settings: {},
                    schedules: {}
                }
            }
        };
        await collection.insertOne(state);
    }
    return state;
};

const writeDbState = async (state) => {
    if (!isConnected) throw new Error("資料庫未連線");
    await collection.updateOne(
        { _id: SINGLETON_DOC_ID },
        { $set: state },
        { upsert: true }
    );
};

// --- Holiday Data Caching ---
let cachedHolidays = null;
async function loadHolidays() {
    if (cachedHolidays) return cachedHolidays;
    
    const holidaysDir = path.join(__dirname, 'holidays');
    let allHolidays = [];
    
    try {
        const files = await fs.readdir(holidaysDir);
        for (const file of files) {
            if (path.extname(file) === '.json') {
                const filePath = path.join(holidaysDir, file);
                const fileContent = await fs.readFile(filePath, 'utf-8');
                const yearHolidays = JSON.parse(fileContent);
                allHolidays = allHolidays.concat(yearHolidays);
            }
        }
        cachedHolidays = allHolidays;
        console.log(`成功載入 ${cachedHolidays.length} 筆假日資料。`);
        return cachedHolidays;
    } catch (error) {
        console.error("!!! 讀取假日資料檔案失敗:", error);
        return []; 
    }
}


// Middleware to check DB connection
app.use(async (req, res, next) => {
    if (!isConnected) {
        return res.status(503).json({ message: "伺服器正在連線到資料庫，請稍後再試。" });
    }
    next();
});


// === API Endpoints ===

// GET holiday data
app.get('/api/holidays', async (req, res) => {
    try {
        const holidays = await loadHolidays();
        if (holidays.length === 0) {
            return res.status(500).json({ message: "伺服器上找不到假日資料檔案。" });
        }
        res.json(holidays);
    } catch (e) {
        res.status(500).json({ message: "讀取假日資料時發生伺服器錯誤。" });
    }
});

// GET all data
app.get('/api/data', async (req, res) => {
    try {
        const dbState = await getDbState();
        res.json(dbState);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// POST a new profile
app.post('/api/profiles', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: '缺少名稱' });
    try {
        const dbState = await getDbState();
        if (dbState.profiles[name]) {
            return res.status(409).json({ message: '設定檔名稱已存在' });
        }
        dbState.profiles[name] = { settings: {}, schedules: {} };
        dbState.activeProfile = name;
        await writeDbState(dbState);
        res.status(201).json({ message: '設定檔已建立' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST to rename a profile
app.post('/api/profiles/rename', async (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ message: '缺少新舊名稱' });
    try {
        const dbState = await getDbState();
        if (!dbState.profiles[oldName]) return res.status(404).json({ message: '找不到要重新命名的設定檔' });
        if (dbState.profiles[newName]) return res.status(409).json({ message: '新的設定檔名稱已存在' });
        
        dbState.profiles[newName] = dbState.profiles[oldName];
        delete dbState.profiles[oldName];
        if (dbState.activeProfile === oldName) {
            dbState.activeProfile = newName;
        }
        await writeDbState(dbState);
        res.status(200).json({ message: '重新命名成功' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST to delete a profile
app.post('/api/profiles/delete', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: '缺少名稱' });
    if (name === DEFAULT_PROFILE_NAME) return res.status(400).json({ message: '無法刪除預設設定檔' });
     try {
        const dbState = await getDbState();
        if (!dbState.profiles[name]) return res.status(404).json({ message: '找不到要刪除的設定檔' });

        delete dbState.profiles[name];
        if (dbState.activeProfile === name) {
            dbState.activeProfile = DEFAULT_PROFILE_NAME;
        }
        await writeDbState(dbState);
        res.status(200).json({ message: '刪除成功' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST to import settings
app.post('/api/profiles/import', async (req, res) => {
    const { name, settings } = req.body;
    if (!name || settings === undefined) return res.status(400).json({ message: '缺少名稱或設定' });
    try {
        const dbState = await getDbState();
        if (dbState.profiles[name]) {
             return res.status(409).json({ message: '設定檔名稱已存在' });
        }
        dbState.profiles[name] = { settings, schedules: {} };
        dbState.activeProfile = name;
        await writeDbState(dbState);
        res.status(201).json({ message: '設定已匯入為新設定檔' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST active profile
app.post('/api/active_profile', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: '缺少名稱' });
    try {
        const dbState = await getDbState();
        if (!dbState.profiles[name]) return res.status(404).json({ message: '找不到指定的設定檔' });
        dbState.activeProfile = name;
        await writeDbState(dbState);
        res.status(200).json({ message: '已切換作用中設定檔' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST settings
app.post('/api/settings', async (req, res) => {
    const settings = req.body;
    try {
        const dbState = await getDbState();
        dbState.profiles[dbState.activeProfile].settings = settings;
        await writeDbState(dbState);
        res.status(200).json({ message: '設定已儲存' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET schedule data
app.get('/api/schedules/:name', async (req, res) => {
    const { name } = req.params;
    try {
        const dbState = await getDbState();
        const scheduleData = dbState.profiles[dbState.activeProfile]?.schedules[name];
        if (scheduleData) {
            res.json(scheduleData);
        } else {
            res.status(404).json({ message: '找不到班表' });
        }
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST new schedule
app.post('/api/schedules', async (req, res) => {
    const { name, data } = req.body;
    if (!name || !data) return res.status(400).json({ message: '缺少名稱或內容' });
    try {
        const dbState = await getDbState();
        dbState.profiles[dbState.activeProfile].schedules[name] = data;
        await writeDbState(dbState);
        res.status(201).json({ message: '班表已儲存' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE schedule
app.delete('/api/schedules/:name', async (req, res) => {
    const { name } = req.params;
    try {
        const dbState = await getDbState();
        if (dbState.profiles[dbState.activeProfile]?.schedules[name]) {
            delete dbState.profiles[dbState.activeProfile].schedules[name];
            await writeDbState(dbState);
            res.status(200).json({ message: '班表已刪除' });
        } else {
            res.status(404).json({ message: '找不到要刪除的班表' });
        }
    } catch (e) { res.status(500).json({ message: e.message }); }
});


// --- Fallback to serve index.html ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, async () => {
    await connectToDb();
    await loadHolidays(); // Pre-cache holidays on startup
    console.log(`伺服器正在 http://localhost:${PORT} 上運行`);
});

