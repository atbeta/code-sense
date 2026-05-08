/**
 * PagingMixin — shared pagination logic for list components
 * @module: shared
 * @dependency: none
 */
export const PagingMixin = {
  data() {
    return {
      currentPage: 1,
      pageSize: 20,
      totalCount: 0,
    };
  },
  computed: {
    totalPages() {
      return Math.ceil(this.totalCount / this.pageSize);
    },
  },
  methods: {
    goToPage(page) {
      this.currentPage = page;
      this.fetchData();
    },
    fetchData() {
      // Override in component
    },
  },
};
