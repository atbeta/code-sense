export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface EntityInstance {
  type: string; // entity type name from config
  id: string; // unique node id
  filePath: string;
  properties: Record<string, unknown>;
  variant?: string; // e.g. 'pinia' | 'vuex'
}

export interface RelationInstance {
  type: string; // relationship type name from config
  fromId: string;
  toId: string;
  properties?: Record<string, unknown>;
}
