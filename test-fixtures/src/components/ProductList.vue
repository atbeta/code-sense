<template>
  <div class="product-page">
    <ProductCard v-for="product in products" :key="product.id" :product="product" />
    <p v-if="isLoading">Loading...</p>
  </div>
</template>

<script>
/**
 * @api-mode: options
 * @chart-type: none
 * @migration-status: pending
 */
import { mapState, mapActions } from 'vuex';
import ProductCard from './ProductCard.vue';

export default {
  name: 'ProductList',
  components: { ProductCard },
  computed: {
    ...mapState('products', ['products', 'isLoading']),
  },
  methods: {
    ...mapActions('products', ['fetchProducts']),
  },
  mounted() {
    this.fetchProducts();
  },
};
</script>
