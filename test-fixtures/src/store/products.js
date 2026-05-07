// Vuex module: products
const state = {
  products: [],
  isLoading: false,
};

const mutations = {
  SET_PRODUCTS(state, products) {
    state.products = products;
  },
  SET_LOADING(state, loading) {
    state.isLoading = loading;
  },
};

const actions = {
  fetchProducts({ commit }) {
    commit('SET_LOADING', true);
    setTimeout(() => {
      commit('SET_PRODUCTS', [{ id: 1, name: 'Widget' }]);
      commit('SET_LOADING', false);
    });
  },
};

export default {
  namespaced: true,
  state,
  mutations,
  actions,
};
