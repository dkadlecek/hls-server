// Reference Swift code for iOS implemetation

import Foundation
import AVFoundation

// MARK: - Data Models

struct VideoSession: Codable {
    let sessionId: String
    let uploadUrl: String
    let playlistUrl: String
    let segmentDuration: Double?
}

struct ChunkUploadResponse: Codable {
    let success: Bool
    let chunk: ChunkInfo?
    let `init`: String?
    
    struct ChunkInfo: Codable {
        let id: String
        let filename: String
        let size: Int
    }
}

struct FinalizeResponse: Codable {
    let success: Bool
    let sessionId: String
    let playlistUrl: String
}

struct ErrorResponse: Codable {
    let error: String
}

// MARK: - Error Handling

enum HLSClientError: Error, LocalizedError {
    case invalidURL
    case invalidResponse
    case serverError(String)
    case networkError(Error)
    
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .invalidResponse:
            return "Invalid response from server"
        case .serverError(let message):
            return "Server error: \(message)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

// MARK: - HLS Server Client

class HLSAPIClient: NSObject {
    private let baseURL: String
    private let session: URLSession
    
    // MARK: - Type Aliases for Completion Blocks
    
    typealias VideoSessionCompletion = (Result<VideoSession, HLSClientError>) -> Void
    typealias ChunkUploadCompletion = (Result<ChunkUploadResponse, HLSClientError>) -> Void
    typealias FinalizeCompletion = (Result<FinalizeResponse, HLSClientError>) -> Void
    typealias PlaylistCompletion = (Result<String, HLSClientError>) -> Void
    typealias DataCompletion = (Result<Data, HLSClientError>) -> Void
    typealias VoidCompletion = (Result<Void, HLSClientError>) -> Void
    
    // MARK: - Initialization
    
    init(baseURL: String = "http://192.168.7.183:3000") {
        self.baseURL = baseURL
        self.session = URLSession.shared
        super.init()
    }
    
    // MARK: - Session Management
    
    /// Creates a new video session with completion block
    func createVideoSession(segmentDuration: Double? = nil, completion: @escaping VideoSessionCompletion) {
        guard let url = URL(string: "\(baseURL)/video/sessions") else {
            completion(.failure(.invalidURL))
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        // Create request body with segmentDuration if provided
        var requestBody: [String: Any] = [:]
        if let segmentDuration = segmentDuration {
            requestBody["segmentDuration"] = segmentDuration
        }
        
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: requestBody)
        } catch {
            completion(.failure(.networkError(error)))
            return
        }
        
        session.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    completion(.failure(.networkError(error)))
                    return
                }
                
                guard let httpResponse = response as? HTTPURLResponse else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                guard let data = data else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                if httpResponse.statusCode != 200 {
                    let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data)
                    completion(.failure(.serverError(errorResponse?.error ?? "Unknown error")))
                    return
                }
                
                do {
                    let videoSession = try JSONDecoder().decode(VideoSession.self, from: data)
                    completion(.success(videoSession))
                } catch {
                    completion(.failure(.networkError(error)))
                }
            }
        }.resume()
    }
    
    // MARK: - Chunk Upload
    
    /// Uploads a video chunk with completion block
    /// Automatically determines if it's the first chunk based on filename
    /// For init segments: use filename "init_0.mp4"
    /// For regular segments: use filename with pattern "segment_{chunkId}.mp4"
    func uploadChunk(
        sessionId: String,
        fileURL: URL,
        completion: @escaping ChunkUploadCompletion
    ) {
        let filename = fileURL.lastPathComponent
        
        // Determine if this is the first chunk and extract chunkId from filename
        let (chunkId, isFirst) = parseChunkInfo(from: filename)
        
        uploadChunk(
            sessionId: sessionId,
            chunkId: chunkId,
            fileURL: fileURL,
            filename: filename,
            isFirst: isFirst,
            completion: completion
        )
    }
    
    /// Helper function to parse chunk information from filename
    /// Returns (chunkId, isFirst) tuple
    private func parseChunkInfo(from filename: String) -> (String, Bool) {
        let lowercaseFilename = filename.lowercased()
        
        // Check if it's an init segment: init_0.mp4
        if lowercaseFilename == "init_0.mp4" {
            return ("0", true)
        }
        
        // Check if it matches the segment pattern: segment_{chunkId}.mp4
        if lowercaseFilename.hasPrefix("segment_") && lowercaseFilename.hasSuffix(".mp4") {
            let withoutPrefix = lowercaseFilename.dropFirst(8) // Remove "segment_"
            let withoutSuffix = withoutPrefix.dropLast(4) // Remove ".mp4"
            
            if let chunkId = Int(withoutSuffix) {
                return (String(chunkId), false)
            }
        }
        
        // Default fallback - treat as regular chunk with ID 0
        return ("0", false)
    }
    
    /// Internal method for chunk upload with isFirst parameter
    private func uploadChunk(
        sessionId: String,
        chunkId: String,
        fileURL: URL,
        filename: String?,
        isFirst: Bool,
        completion: @escaping ChunkUploadCompletion
    ) {
        // Read data from file URL
        do {
            let data = try Data(contentsOf: fileURL)
            
            guard let url = URL(string: "\(baseURL)/video/sessions/\(sessionId)/chunks/\(chunkId)") else {
                completion(.failure(.invalidURL))
                return
            }
            
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            
            let boundary = "Boundary-\(UUID().uuidString)"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            
            var body = Data()
            
            // Add chunk data
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"chunk\"; filename=\"\(filename ?? (isFirst ? "init.mp4" : "chunk_\(chunkId).mp4"))\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: video/mp4\r\n\r\n".data(using: .utf8)!)
            body.append(data)
            body.append("\r\n".data(using: .utf8)!)
            
            // Add isFirst flag
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"isFirst\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(isFirst ? "true" : "false")\r\n".data(using: .utf8)!)
            
            // Add filename if provided
            if let filename = filename {
                body.append("--\(boundary)\r\n".data(using: .utf8)!)
                body.append("Content-Disposition: form-data; name=\"filename\"\r\n\r\n".data(using: .utf8)!)
                body.append("\(filename)\r\n".data(using: .utf8)!)
            }
            
            body.append("--\(boundary)--\r\n".data(using: .utf8)!)
            
            request.httpBody = body
            
            session.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    if let error = error {
                        completion(.failure(.networkError(error)))
                        return
                    }
                    
                    guard let httpResponse = response as? HTTPURLResponse else {
                        completion(.failure(.invalidResponse))
                        return
                    }
                    
                    guard let data = data else {
                        completion(.failure(.invalidResponse))
                        return
                    }
                    
                    if httpResponse.statusCode != 200 {
                        let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data)
                        completion(.failure(.serverError(errorResponse?.error ?? "Upload failed")))
                        return
                    }
                    
                    do {
                        let uploadResponse = try JSONDecoder().decode(ChunkUploadResponse.self, from: data)
                        completion(.success(uploadResponse))
                    } catch {
                        completion(.failure(.networkError(error)))
                    }
                }
            }.resume()
            
        } catch {
            completion(.failure(.networkError(error)))
        }
    }
    
    // MARK: - Session Finalization
    
    /// Finalizes the video session and generates the HLS playlist with completion block
    func finalizeVideoSession(sessionId: String, completion: @escaping FinalizeCompletion) {
        guard let url = URL(string: "\(baseURL)/video/sessions/\(sessionId)/finalize") else {
            completion(.failure(.invalidURL))
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    completion(.failure(.networkError(error)))
                    return
                }
                
                guard let httpResponse = response as? HTTPURLResponse else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                guard let data = data else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                if httpResponse.statusCode != 200 {
                    let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data)
                    completion(.failure(.serverError(errorResponse?.error ?? "Finalization failed")))
                    return
                }
                
                do {
                    let finalizeResponse = try JSONDecoder().decode(FinalizeResponse.self, from: data)
                    completion(.success(finalizeResponse))
                } catch {
                    completion(.failure(.networkError(error)))
                }
            }
        }.resume()
    }
    
    // MARK: - Playlist and Media Access
    
    /// Fetches the HLS playlist for a session with completion block
    func getPlaylist(sessionId: String, completion: @escaping PlaylistCompletion) {
        guard let url = URL(string: "\(baseURL)/video/sessions/\(sessionId)/playlist.m3u8") else {
            completion(.failure(.invalidURL))
            return
        }
        
        session.dataTask(with: url) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    completion(.failure(.networkError(error)))
                    return
                }
                
                guard let httpResponse = response as? HTTPURLResponse else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                guard let data = data else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                if httpResponse.statusCode != 200 {
                    let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data)
                    completion(.failure(.serverError(errorResponse?.error ?? "Failed to fetch playlist")))
                    return
                }
                
                guard let playlist = String(data: data, encoding: .utf8) else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                completion(.success(playlist))
            }
        }.resume()
    }
    
    /// Gets the URL for a specific video file/chunk
    func getVideoChunkURL(sessionId: String, filename: String) -> URL? {
        return URL(string: "\(baseURL)/video/sessions/\(sessionId)/\(filename)")
    }
    
    /// Downloads a video chunk with completion block
    func downloadVideoChunk(sessionId: String, filename: String, completion: @escaping DataCompletion) {
        guard let url = URL(string: "\(baseURL)/video/sessions/\(sessionId)/\(filename)") else {
            completion(.failure(.invalidURL))
            return
        }
        
        session.dataTask(with: url) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    completion(.failure(.networkError(error)))
                    return
                }
                
                guard let httpResponse = response as? HTTPURLResponse else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                guard let data = data else {
                    completion(.failure(.invalidResponse))
                    return
                }
                
                if httpResponse.statusCode != 200 {
                    let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data)
                    completion(.failure(.serverError(errorResponse?.error ?? "Failed to download chunk")))
                    return
                }
                
                completion(.success(data))
            }
        }.resume()
    }
    
    // MARK: - Helper Methods
    
    /// Creates an AVPlayer with the HLS playlist URL
    func createPlayer(for sessionId: String) -> AVPlayer? {
        guard let playlistURL = URL(string: "\(baseURL)/video/sessions/\(sessionId)/playlist.m3u8") else {
            return nil
        }
        
        let playerItem = AVPlayerItem(url: playlistURL)
        return AVPlayer(playerItem: playerItem)
    }
    
}
