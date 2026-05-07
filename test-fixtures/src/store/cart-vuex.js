// Vuex module: cart
const state = {
  items: [],
  totalPrice: 0,
};

const mutations = {
  ADD_ITEM(state, item) {
    state.items.push(item);
  },
  DEL_COLLECTION(state, id) {
    state.items = state.items.filter((i) => i.id !== id);
  },
  CLEAR_CART(state) {
    state.items = [];
  },
};

const actions = {
  addToCart({ commit }, item) {
    commit('ADD_ITEM', item);
  },
};

export default {
  namespaced: true,
  state,
  mutations,
  actions,
};
