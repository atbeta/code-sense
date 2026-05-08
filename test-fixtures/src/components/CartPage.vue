<template>
  <div class="cart-page">
    <CartItem v-for="item in cartItems" :key="item.id" :item="item"
      @add="handleAddItem" @remove="handleRemoveItem" />
    <button @click="checkout">Checkout ({{ total }})</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useCartStore } from '../store/cart';

const cart = useCartStore();

const cartItems = computed(() => cart.items);
const total = computed(() => cart.totalPrice);

function handleAddItem(item: any) {
  validateItem(item);
  cart.addItem(item);
}

function handleRemoveItem(id: number) {
  cart.removeItem(id);
}

function validateItem(item: any): boolean {
  if (!item.id || !item.name) return false;
  return formatPrice(item.price) > 0;
}

function formatPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

async function checkout() {
  const valid = cartItems.value.every(item => validateItem(item));
  if (!valid) return;
  await submitOrder(cartItems.value);
  cart.clearCart();
}

async function submitOrder(items: any[]) {
  const response = await fetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  return response.json();
}
</script>
