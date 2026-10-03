/** Page-local refusal of notification requests; never changes profile permissions or takes control. */
export const DENY_NOTIFICATIONS = `(() => {
  if (typeof Notification !== "undefined") {
    Object.defineProperties(Notification, {
      permission: { configurable: true, get: () => "denied" },
      requestPermission: {
        configurable: true,
        writable: true,
        value: function(callback) {
          if (typeof callback === "function") queueMicrotask(() => callback("denied"));
          return Promise.resolve("denied");
        },
      },
    });
  }
  const query = navigator.permissions?.query?.bind(navigator.permissions);
  if (query) {
    navigator.permissions.query = descriptor => {
      if (descriptor?.name !== "notifications") return query(descriptor);
      const status = new EventTarget();
      Object.defineProperties(status, {
        name: { value: "notifications", enumerable: true },
        state: { value: "denied", enumerable: true },
        onchange: { value: null, writable: true, enumerable: true },
      });
      return Promise.resolve(status);
    };
  }
  // Push SDKs can ask for the same permission without calling Notification.requestPermission.
  if (typeof PushManager !== "undefined") {
    Object.defineProperties(PushManager.prototype, {
      subscribe: {
        configurable: true,
        writable: true,
        value: () => Promise.reject(new DOMException("Notifications disabled for capture.", "NotAllowedError")),
      },
      permissionState: {
        configurable: true,
        writable: true,
        value: () => Promise.resolve("denied"),
      },
    });
  }
})();`;
