import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../components/App.vue'),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
