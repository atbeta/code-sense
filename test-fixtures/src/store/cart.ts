import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

interface CartItem {
  id: number;
  name: string;
  price: number;
  quantity: number;
}

/**
 * @store-type: cart
 * @persist: localStorage
 */
export const useCartStore = defineStore('cart', () => {
  const items = ref<CartItem[]>([]);
  const couponCode = ref<string | null>(null);

  const totalPrice = computed(() =>
    items.value.reduce((sum, item) => sum + item.price * item.quantity, 0)
  );

  const itemCount = computed(() =>
    items.value.reduce((sum, item) => sum + item.quantity, 0)
  );

  function addItem(item: CartItem) {
    const existing = items.value.find((i) => i.id === item.id);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      items.value.push(item);
    }
  }

  function removeItem(id: number) {
    items.value = items.value.filter((i) => i.id !== id);
  }

  function clearCart() {
    items.value = [];
    couponCode.value = null;
  }

  function applyCoupon(code: string) {
    couponCode.value = code;
  }

  return { items, couponCode, totalPrice, itemCount, addItem, removeItem, clearCart, applyCoupon };
});
