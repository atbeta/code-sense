import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../components/App.vue'),
    meta: { requiresAuth: false, title: 'Home' },
    alias: ['/dashboard'],
    children: [
      {
        path: 'cart',
        name: 'Cart',
        component: () => import('../components/CartPage.vue'),
        meta: { requiresAuth: true },
        beforeEnter: () => true,
      },
      {
        path: 'products',
        name: 'Products',
        component: () => import('../components/ProductList.vue'),
      },
    ],
  },
  {
    path: '/users',
    name: 'Users',
    component: () => import('../components/UserList.vue'),
  },
  {
    path: '/legacy-cart',
    redirect: '/cart',
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
