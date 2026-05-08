<template>
  <div class="app-info">
    <p>Version: {{ appVersion }}</p>
    <button @click="saveNotes">Save Notes</button>
    <span v-if="saved">Saved!</span>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

const appVersion = ref('loading...');
const saved = ref(false);

onMounted(async () => {
  const info = await window.electronAPI.getAppVersion();
  appVersion.value = info.version;
});

async function saveNotes() {
  await window.electronAPI.saveFile('/tmp/notes.txt', 'hello from renderer');
  saved.value = true;
}

// Also call notify-ready directly
window.electronAPI.notifyReady(1);
</script>
