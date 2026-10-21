/**
 * Automerge's WASM must be loaded before any document call, in tests as much
 * as in the plugin. Without this every Automerge call throws
 * "Automerge.use() not called".
 */
import { initAutomerge } from "../src/sync";

await initAutomerge();