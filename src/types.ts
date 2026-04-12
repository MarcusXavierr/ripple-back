// SYNC: keep identical to videocall-frontend/src/types/signaling.ts

export const CLOSE_CODES = {
  ROOM_FULL:         4001,
  PEER_DISCONNECTED: 4002,
  ROOM_NOT_FOUND:    4003,
  DUPLICATE_SESSION: 4004,
  PING_TIMEOUT:      4005,
} as const

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES]

// Server → Client
export type ServerMessage =
  | { type: 'onopen'; role: 'caller' | 'callee'; reconnect: boolean }
  | { type: 'enter' }
  | { type: 'onclose'; message: string }
  | { type: 'peer-reconnected' }
  | { type: 'ping' }

// Client → Server
export type ClientMessage =
  | { type: 'offer'; offer: RTCSessionDescriptionInit }
  | { type: 'answer'; answer: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'pong' }
  | { type: 'error'; code: 'ICE_FAILED' | 'MEDIA_DENIED' }

export type Role = 'caller' | 'callee'
