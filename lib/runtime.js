import { MemoryConversationStore } from './conversation-manager.js';
import { ToolSchemaRegistry } from './tool-schema-registry.js';
import { ToolExecutionLedger } from './tool-execution-ledger.js';
import { CheckpointManager, ContextCheckpointStore } from './context-checkpoint.js';
import { RotationRecommendationStore } from './backend-conversation-generation.js';

export const conversationStore = new MemoryConversationStore();
export const checkpointStore = new ContextCheckpointStore();
export const checkpointManager = new CheckpointManager({ store: checkpointStore });
export const rotationRecommendationStore = new RotationRecommendationStore();
export const toolSchemaRegistry = new ToolSchemaRegistry();
export const toolExecutionLedger = new ToolExecutionLedger();
