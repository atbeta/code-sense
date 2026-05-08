<template>
  <div class="user-list">
    <div v-for="user in displayUsers" :key="user.id" class="user-item">
      {{ user.name }}
    </div>
    <Pagination :current="currentPage" :total="totalPages" @change="goToPage" />
  </div>
</template>

<script>
import { PagingMixin } from '../mixins/PagingMixin';

export default {
  name: 'UserList',
  mixins: [PagingMixin],
  data() {
    return {
      users: [],
    };
  },
  computed: {
    displayUsers() {
      const start = (this.currentPage - 1) * this.pageSize;
      return this.users.slice(start, start + this.pageSize);
    },
  },
  methods: {
    fetchData() {
      // Fetch users from API
    },
  },
  mounted() {
    this.fetchData();
  },
};
</script>
