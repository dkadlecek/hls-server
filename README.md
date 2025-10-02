# HLS Video Server

A TypeScript-based HTTP Live Streaming (HLS) server built with Koa.js that allows uploading and serving video content in HLS format.

## Features

- **Video Session Management**: Create video sessions with custom segment durations
- **Chunk Upload**: Upload video chunks (init segments and regular segments)
- **HLS Playlist Generation**: Automatically generate HLS playlists (.m3u8)
- **CORS Support**: Cross-origin resource sharing enabled
- **TypeScript**: Full TypeScript support with strict type checking
- **Memory-based Session Storage**: Efficient in-memory session metadata management

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd hls-server
```

2. Install dependencies:
```bash
npm install
```

## Development

### Run in Development Mode
```bash
npm run dev
```
This uses `ts-node` to run the TypeScript code directly without compilation.

### Build the Project
```bash
npm run build
```
This compiles TypeScript to JavaScript in the `dist/` directory.

### Run Production Build
```bash
npm start
```
This runs the compiled JavaScript from the `dist/` directory.

### Watch Mode
```bash
npm run watch
```
This compiles TypeScript in watch mode, automatically recompiling on file changes.

### Clean Build
```bash
npm run clean
```
This removes the `dist/` directory.

## API Endpoints

### Create Video Session
```http
POST /video/sessions
Content-Type: application/json

{
  "segmentDuration": 6
}
```

**Response:**
```json
{
  "sessionId": "uuid-here",
  "uploadUrl": "/video/sessions/uuid-here/chunks",
  "playlistUrl": "/video/sessions/uuid-here/playlist.m3u8",
  "segmentDuration": 6
}
```

### Upload Video Chunk
```http
POST /video/sessions/:sessionId/chunks/:chunkId
Content-Type: multipart/form-data

chunk: [binary data]
isFirst: true/false
filename: "init.mp4" (optional)
```

### Finalize Video Session
```http
POST /video/sessions/:sessionId/finalize
```

### Get HLS Playlist
```http
GET /video/sessions/:sessionId/playlist.m3u8
```

### Get Video Chunk
```http
GET /video/sessions/:sessionId/:filename
```

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3000)
- `STORAGE_PATH`: Path to video storage directory (default: ./storage)

### TypeScript Configuration

The project uses strict TypeScript configuration with:
- Strict type checking enabled
- ES2020 target
- CommonJS modules
- Source maps for debugging
- Declaration files generation

## Project Structure

```
hls-server/
├── src/
│   └── video.ts          # Main server file
├── dist/                 # Compiled JavaScript (generated)
├── storage/              # Video storage directory
├── package.json
├── tsconfig.json         # TypeScript configuration
├── .gitignore
└── README.md
```

## Development Workflow

1. **Development**: Use `npm run dev` for development with hot reloading
2. **Testing**: Build with `npm run build` and test the compiled version
3. **Production**: Use `npm start` to run the production build

## Type Safety

The project includes comprehensive TypeScript types for:
- API request/response interfaces
- Session metadata
- Error responses
- Koa context types

## License

ISC
