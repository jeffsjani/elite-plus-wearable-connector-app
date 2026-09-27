export type ConnectorConnectionState =
  | 'UNAUTHENTICATED'
  | 'AUTHENTICATED'
  | 'REGISTERING'
  | 'REGISTERED'
  | 'TESTING'
  | 'CONNECTED'
  | 'ERROR'