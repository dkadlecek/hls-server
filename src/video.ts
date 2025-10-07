import * as fs from 'fs/promises';
import * as fs_standard from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from '@koa/multer';
import Router from '@koa/router';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';

// Type definitions
interface SessionMetadata {
  sessionId: string;
  segmentDuration: number;
  createdAt: string;
}

// Extend Koa Context to include body property
interface AppContext extends Koa.Context {
  request: Koa.Request & {
    body?: any;
  };
}

interface CreateSessionRequest {
  sessionId?: string;
  segmentDuration?: number;
}

interface CreateSessionResponse {
  sessionId: string;
  uploadUrl: string;
  playlistUrl: string;
  segmentDuration: number;
}

interface ChunkUploadResponse {
  success: boolean;
  chunk?: {
    id: string;
    filename: string;
    size: number;
  };
  init?: string;
}

interface FinalizeResponse {
  success: boolean;
  sessionId: string;
  playlistUrl: string;
}

interface ErrorResponse {
  error: string;
}

// Constants
const router = new Router();
const VIDEO_BASE_DIR = path.join(process.env['STORAGE_PATH'] || './storage', 'videos');
const DEFAULT_SEGMENT_DURATION = 5;

// Global storage for session metadata
const sessionMetadata = new Map<string, SessionMetadata>();

// Helper function to get session metadata
function getSessionMetadata(sessionId: string): SessionMetadata | undefined {
  return sessionMetadata.get(sessionId);
}

// Helper function to clean up session metadata
function cleanupSessionMetadata(sessionId: string): void {
  sessionMetadata.delete(sessionId);
}

// Helper function to get base URL from request context
function getBaseUrl(ctx: AppContext): string {
  // Use X-Forwarded-Proto and X-Forwarded-Host if behind a proxy, otherwise use ctx values
  const protocol = ctx.get('X-Forwarded-Proto') || ctx.protocol;
  const host = ctx.get('X-Forwarded-Host') || ctx.host;
  return `${protocol}://${host}`;
}

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Load existing sessions from filesystem on startup
async function loadSessionsFromFilesystem(): Promise<void> {
  try {
    await fs.mkdir(VIDEO_BASE_DIR, { recursive: true });
    const entries = await fs.readdir(VIDEO_BASE_DIR, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionId = entry.name;
        const sessionDir = path.join(VIDEO_BASE_DIR, sessionId);
        const playlistPath = path.join(sessionDir, 'playlist.m3u8');
        
        let segmentDuration = DEFAULT_SEGMENT_DURATION;
        let createdAt = new Date().toISOString();
        
        // Try to read segment duration from playlist
        try {
          const playlistContent = await fs.readFile(playlistPath, 'utf8');
         
          const targetDurationMatch = playlistContent.match(/#EXT-X-TARGETDURATION:(\d+)/);
          if (targetDurationMatch && targetDurationMatch[1]) {
            segmentDuration = parseInt(targetDurationMatch[1], 10);
          }
        } catch (error) {
          // Playlist doesn't exist or can't be read, use default duration
          console.log(`[STARTUP] No playlist found for session ${sessionId}, using default segment duration`);
        }
        
        // Try to get directory creation time
        try {
          const stats = await fs.stat(sessionDir);
          createdAt = stats.birthtime.toISOString();
        } catch (error) {
          // Use current time if stat fails
          createdAt = new Date().toISOString();
        }
        
        sessionMetadata.set(sessionId, {
          sessionId,
          segmentDuration,
          createdAt
        });
        
        console.log(`[STARTUP] Loaded session ${sessionId} with segment duration ${segmentDuration}s`);
      }
    }
    
    console.log(`[STARTUP] Loaded ${sessionMetadata.size} session(s) from filesystem`);
  } catch (error) {
    console.error('[STARTUP] Error loading sessions from filesystem:', error);
  }
}

// Generate HLS playlist
async function generateHLSPlaylist(sessionId: string, sequenceId: string = '0', isFinal: boolean = false): Promise<string> {
  console.log(`[DEBUG] generateHLSPlaylist called with sessionId: ${sessionId}, sequenceID: ${sequenceId}`);
  const sessionDir = path.join(VIDEO_BASE_DIR, sessionId);
  console.log(`[DEBUG] sessionDir: ${sessionDir}`);
  
  let files;
  try {
    files = await fs.readdir(sessionDir);
  } catch (error) {
    console.error(`[DEBUG] Error reading directory ${sessionDir}:`, error);
    throw error;
  }

  const initFile = files.find(f => f.toLowerCase().includes('init') && /\.(mp4|m4s)$/i.test(f));
  const segmentFiles = files
    .filter(f => /^chunk\d+\.(mp4|m4s)$/i.test(f))
    .sort((a, b) => {
      const numA = parseInt((a.match(/^chunk(\d+)\.(mp4|m4s)$/i) || [])[1] || '0', 10);
      const numB = parseInt((b.match(/^chunk(\d+)\.(mp4|m4s)$/i) || [])[1] || '0', 10);
      return numA - numB;
    });

  // Get segmentDuration from global variable
  let segmentDuration = DEFAULT_SEGMENT_DURATION;
  const metadata = getSessionMetadata(sessionId);
  if (metadata && metadata.segmentDuration) {
    segmentDuration = metadata.segmentDuration;
  } else {
    console.warn(`No session metadata found for ${sessionId}, using default segment duration: ${DEFAULT_SEGMENT_DURATION}`);
  }

  let playlist = '#EXTM3U\n';
  playlist += '#EXT-X-VERSION:7\n';
  playlist += '#EXT-X-PLAYLIST-TYPE:EVENT\n';
  playlist += `#EXT-X-TARGETDURATION:${segmentDuration}\n`;
  playlist += `#EXT-X-MEDIA-SEQUENCE:${sequenceId}\n`;

  if (initFile) {
    playlist += `#EXT-X-MAP:URI="${initFile}"\n`;
  }

  playlist += '\n';

  for (const segmentFile of segmentFiles) {
    playlist += `#EXTINF:${segmentDuration}.000,\n`;
    playlist += `${segmentFile}\n`;
  }

  if (isFinal) {
    playlist += '#EXT-X-ENDLIST\n';
  }

  return playlist;
}

// Routes
router.post('/video/sessions', async (ctx: AppContext) => {
  try {
    const requestBody = ctx.request.body as CreateSessionRequest | undefined;
    const segmentDuration = requestBody?.segmentDuration || DEFAULT_SEGMENT_DURATION;

    const sessionId = requestBody?.sessionId || uuidv4();
    const sessionDir = path.join(VIDEO_BASE_DIR, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
     
    // Validate segmentDuration is a positive number
    const parsedDuration = parseFloat(segmentDuration.toString());
    if (isNaN(parsedDuration) || parsedDuration <= 0) {
      ctx.status = 400;
      ctx.body = { error: 'segmentDuration must be a positive number' } as ErrorResponse;
      return;
    }

    // Store session metadata in global variable
    sessionMetadata.set(sessionId, {
      sessionId,
      segmentDuration: parsedDuration,
      createdAt: new Date().toISOString()
    });

    console.log(`[SESSION] Created session ${sessionId} with segment duration ${parsedDuration}s. Total active sessions: ${sessionMetadata.size}`);

    const baseUrl = getBaseUrl(ctx);
    ctx.body = {
      sessionId,
      uploadUrl: `${baseUrl}/video/sessions/${sessionId}/chunks`,
      playlistUrl: `${baseUrl}/video/sessions/${sessionId}/playlist.m3u8`,
      segmentDuration: parsedDuration
    } as CreateSessionResponse;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to create video session' } as ErrorResponse;
    console.error('Session creation error:', error);
  }
});

router.get('/video/sessions/list', async (ctx: AppContext) => {
  try {
    
    let body = {};
    const baseUrl = getBaseUrl(ctx);
    
    for (const sessionId of sessionMetadata.keys()) {
      body = { ...body, [sessionId]: {
        sessionId,
        uploadUrl: `${baseUrl}/video/sessions/${sessionId}/chunks`,
        playlistUrl: `${baseUrl}/video/sessions/${sessionId}/playlist.m3u8`,
        segmentDuration: sessionMetadata.get(sessionId)?.segmentDuration
      } as CreateSessionResponse
    }
  }

    ctx.body = body;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to list video session' } as ErrorResponse;
    console.error('Session get error:', error);
  }
});

router.post(
  '/video/sessions/:sessionId/chunks/:chunkId',
  upload.single('chunk'),
  async (ctx: AppContext) => {
    try {
      const sessionId = ctx['params']['sessionId'] as string;
      const chunkId = ctx['params']['chunkId'] as string;
      const isFirst = String((ctx.request.body as any)?.isFirst) === 'true';
      const clientFilename = ((ctx.request.body as any)?.filename) || (ctx.file?.originalname);

      if (!ctx.file || !ctx.file.buffer || ctx.file.fieldname !== 'chunk') {
        ctx.status = 400;
        ctx.body = { error: 'Form data must include a binary "chunk" field.' } as ErrorResponse;
        return;
      }

      const sessionDir = path.join(VIDEO_BASE_DIR, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      if (isFirst) {
        const initFilename = clientFilename ? path.basename(clientFilename) : 'init.mp4';
        if (!/\.(mp4|m4s)$/i.test(initFilename)) {
          ctx.status = 400;
          ctx.body = { error: 'Init must be uploaded as .mp4 or .m4s (fragmented MP4 init)' } as ErrorResponse;
          return;
        }
        const initPath = path.join(sessionDir, initFilename);
        await fs.writeFile(initPath, ctx.file.buffer);
        
        ctx.status = 200;
        ctx.body = { success: true, init: initFilename } as ChunkUploadResponse;
        return;
      }

      const filename = clientFilename && typeof clientFilename === 'string'
        ? path.basename(clientFilename)
        : `segment_${String(chunkId).padStart(5, '0')}.mp4`;

      if (!/\.(mp4|m4s)$/i.test(filename)) {
        ctx.status = 400;
        ctx.body = { error: 'Only .mp4 or .m4s fragments are accepted' } as ErrorResponse;
        return;
      }

      const filePath = path.join(sessionDir, filename);
      await fs.writeFile(filePath, ctx.file.buffer);

      try {
        await fs.access(sessionDir);
      } catch (error) {
        ctx.status = 404;
        ctx.body = { error: 'Session not found' } as ErrorResponse;
        return;
      }
      
      const playlist = await generateHLSPlaylist(sessionId, chunkId);
      const playlistPath = path.join(sessionDir, 'playlist.m3u8');
      await fs.writeFile(playlistPath, playlist);
      
      ctx.status = 200;
      ctx.body = {
        success: true,
        chunk: {
          id: chunkId,
          filename,
          size: ctx.file.size ?? ctx.file.buffer.length,
        },
      } as ChunkUploadResponse;
    } catch (error) {
      console.error('Chunk upload error:', error);
      ctx.status = 500;
      ctx.body = { error: 'Failed to process video chunk' } as ErrorResponse;
    }
  },
);

router.post('/video/sessions/:sessionId/finalize', async (ctx: AppContext) => {
  try {
    const sessionId = ctx['params']['sessionId'] as string;
    const sessionDir = path.join(VIDEO_BASE_DIR, sessionId);

    try {
      await fs.access(sessionDir);
    } catch (error) {
      ctx.status = 404;
      ctx.body = { error: 'Session not found' } as ErrorResponse;
      return;
    }

    const playlist = await generateHLSPlaylist(sessionId, '0', true);
    const playlistPath = path.join(sessionDir, 'playlist.m3u8');
    await fs.writeFile(playlistPath, playlist);

    console.log(`[FINALIZE] Created HLS playlist for session ${sessionId}`);

    // Clean up session metadata after finalization
    cleanupSessionMetadata(sessionId);

    const baseUrl = getBaseUrl(ctx);
    ctx.body = {
      success: true,
      sessionId,
      playlistUrl: `${baseUrl}/video/sessions/${sessionId}/playlist.m3u8`
    } as FinalizeResponse;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to finalize video session' } as ErrorResponse;
    console.error('Finalization error:', error);
  }
});

router.get('/video/sessions/:sessionId/playlist.m3u8', async (ctx: AppContext) => {
  try {
    const sessionId = ctx['params']['sessionId'] as string;
    const playlistPath = path.join(VIDEO_BASE_DIR, sessionId, 'playlist.m3u8');

    try {
      await fs.access(playlistPath);
    } catch (error) {
      ctx.status = 404;
      ctx.body = { error: 'Playlist not found' } as ErrorResponse;
      return;
    }

    const playlist = await fs.readFile(playlistPath, 'utf8');
    ctx.type = 'application/vnd.apple.mpegurl';
    ctx.body = playlist;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to serve playlist' } as ErrorResponse;
    console.error('Playlist serving error:', error);
  }
});

router.get('/video/sessions/:sessionId/:filename', async (ctx: AppContext) => {
  try {
    const sessionId = ctx['params']['sessionId'] as string;
    const filename = ctx['params']['filename'] as string;
    const filePath = path.join(VIDEO_BASE_DIR, sessionId, filename);

    try {
      await fs.access(filePath);
    } catch (error) {
      ctx.status = 404;
      ctx.body = { error: 'Chunk not found' } as ErrorResponse;
      return;
    }

    ctx.type = 'video/mp4';
    ctx.body = fs_standard.createReadStream(filePath);
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to serve video chunk' } as ErrorResponse;
    console.error('Chunk serving error:', error);
  }
});

// CORS options
router.options('/video/sessions', (ctx: AppContext) => {
  ctx.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.status = 204;
});

router.options('/video/sessions/:sessionId/chunks/:chunkId', (ctx: AppContext) => {
  ctx.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
  ctx.status = 204;
});

router.options('/video/sessions/:sessionId/finalize', (ctx: AppContext) => {
  ctx.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
  ctx.status = 204;
});

// Create and start the server
const app = new Koa();

// Add body parser middleware
app.use(bodyParser());

app.use(router.routes());
// app.use(router.allowedMethods());

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 3000;

// Initialize server
async function startServer() {
  await loadSessionsFromFilesystem();
  app.listen(PORT, () => {
    console.log(`Video server running at http://localhost:${PORT}/`);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
