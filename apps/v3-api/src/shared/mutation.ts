// Server application result; transport expresses replayed via an HTTP header.
export interface Mutation<T> {
  value: T;
  replayed: boolean;
}
