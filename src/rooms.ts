export const rooms = new Map<string, string[]>()

export const getRoom = (id: string): string[] => rooms.get(id) ?? []

export const addUser = (roomId: string, userId: string): void => {
  rooms.set(roomId, [...getRoom(roomId), userId])
}

export const removeUser = (roomId: string, userId: string): void => {
  rooms.set(roomId, getRoom(roomId).filter(n => n !== userId))
}
