import { defineStore } from 'pinia';

interface User {
  name: string;
  email: string;
}

interface UserState {
  currentUser: User | null;
  users: User[];
}

export const useUserStore = defineStore('user', {
  state: (): UserState => ({
    currentUser: null,
    users: [],
  }),
  getters: {
    isLoggedIn: (state) => state.currentUser !== null,
  },
  actions: {
    fetchCurrentUser() {
      this.currentUser = { name: 'Alice', email: 'alice@example.com' };
    },
  },
});
