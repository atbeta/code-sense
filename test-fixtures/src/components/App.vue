<template>
  <div class="app">
    <h1>{{ title }}</h1>
    <AppInfo />
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useUserStore } from '../store/user';
import AppInfo from './AppInfo.vue';

const title = ref('My App');
const userStore = useUserStore();

const displayName = computed(() => userStore.currentUser?.name ?? 'Guest');

onMounted(() => {
  userStore.fetchCurrentUser();
});
</script>
