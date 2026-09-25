import http from "node:http";

function route(
  pathname: string,
  mutation: boolean,
): string {
  return mutation
    ? `${pathname}?mutation=1`
    : pathname;
}

function html(
  title: string,
  body: string,
  mutation: boolean,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <title>${title}</title>

  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 900px;
      margin: 60px auto;
      padding: 0 24px;
      line-height: 1.5;
      color: #111;
      background: #fff;
    }

    nav {
      display: flex;
      gap: 16px;
      margin-bottom: 40px;
    }

    nav a {
      color: #333;
      text-decoration: none;
    }

    main {
      border: 1px solid #ddd;
      border-radius: 14px;
      padding: 28px;
    }

    article {
      margin: 20px 0;
      padding: 20px;
      border: 1px solid #ddd;
      border-radius: 12px;
    }

    a,
    button {
      display: inline-block;
      padding: 10px 16px;
      margin: 6px 6px 6px 0;
      border: 1px solid #ccc;
      border-radius: 8px;
      background: white;
      color: #111;
      text-decoration: none;
      cursor: pointer;
    }

    input {
      display: block;
      margin: 8px 0 16px;
      padding: 10px;
      width: 300px;
      border: 1px solid #ccc;
      border-radius: 8px;
    }

    .warning {
      padding: 12px;
      margin-bottom: 20px;
      background: #fff3cd;
      border-radius: 8px;
    }
  </style>
</head>

<body>
  <nav aria-label="Main navigation">
    <a href="${route("/", mutation)}">Home</a>
    <a href="${route("/products", mutation)}">
      Products
    </a>
  </nav>

  <main>
    ${body}
  </main>
</body>
</html>`;
}

function pageFor(
  pathname: string,
  mutation: boolean,
): string {
  switch (pathname) {
    case "/":
      return html(
        "ShopFlow",
        `
          <h1>ShopFlow</h1>

          <p>
            Demo storefront for MEU.
          </p>

          <a href="${route("/products", mutation)}">
            Browse Products
          </a>
        `,
        mutation,
      );

    case "/products":
      return html(
        "Products",
        `
          <h1>Products</h1>

          <article>
            <h2>MacBook Pro</h2>

            <p>
              Professional laptop.
            </p>

            <a href="${route(
              "/product/1",
              mutation,
            )}">
              View Product
            </a>
          </article>

          <article>
            <h2>Mechanical Keyboard</h2>

            <p>
              Premium mechanical keyboard.
            </p>

            <a href="${route(
              "/product/2",
              mutation,
            )}">
              View Product
            </a>
          </article>
        `,
        mutation,
      );

    case "/product/1":
      return html(
        "MacBook Pro",
        `
          <h1>MacBook Pro</h1>

          <p>
            Professional laptop for developers.
          </p>

          <a href="${route(
            "/cart",
            mutation,
          )}">
            Add to Cart
          </a>

          <a href="${route(
            "/wishlist",
            mutation,
          )}">
            Wishlist
          </a>
        `,
        mutation,
      );

    case "/product/2":
      return html(
        "Mechanical Keyboard",
        `
          <h1>Mechanical Keyboard</h1>

          <p>
            Premium mechanical keyboard.
          </p>

          <a href="${route(
            "/cart",
            mutation,
          )}">
            Add to Cart
          </a>

          <a href="${route(
            "/wishlist",
            mutation,
          )}">
            Wishlist
          </a>
        `,
        mutation,
      );

    case "/cart":
      return html(
        "Cart",
        `
          <h1>Cart</h1>

          <p>
            1 item in your cart.
          </p>

          <a href="${route(
            "/checkout",
            mutation,
          )}">
            ${
              mutation
                ? "Proceed to Payment"
                : "Checkout"
            }
          </a>
        `,
        mutation,
      );

    case "/checkout":
      return html(
        "Checkout",
        mutation
          ? `
            <div class="warning">
              Mutation Mode is enabled.
            </div>

            <h1>Checkout</h1>

            <label>
              Email
              <input
                type="email"
                placeholder="Email"
              />
            </label>

            <label>
              Address
              <input
                type="text"
                placeholder="Address"
              />
            </label>

            <a href="${route(
              "/payment",
              mutation,
            )}">
              Proceed to Payment
            </a>

            <a href="${route(
              "/",
              mutation,
            )}">
              Cancel Order
            </a>
          `
          : `
            <h1>Checkout</h1>

            <label>
              Email
              <input
                type="email"
                placeholder="Email"
              />
            </label>

            <label>
              Address
              <input
                type="text"
                placeholder="Address"
              />
            </label>

            <a href="${route(
              "/payment",
              mutation,
            )}">
              Checkout
            </a>

            <a href="${route(
              "/",
              mutation,
            )}">
              Cancel Order
            </a>
          `,
        mutation,
      );

    case "/payment":
      return html(
        "Payment",
        `
          <h1>Payment</h1>

          <p>
            Secure payment step.
          </p>

          <a href="${route(
            "/confirmation",
            mutation,
          )}">
            Pay Now
          </a>
        `,
        mutation,
      );

    case "/confirmation":
      return html(
        "Order Confirmed",
        `
          <h1>Order Confirmed</h1>

          <p>
            Your order has been successfully placed.
          </p>
        `,
        mutation,
      );

    case "/wishlist":
      return html(
        "Wishlist",
        `
          <h1>Wishlist</h1>

          <p>
            Product added to wishlist.
          </p>
        `,
        mutation,
      );

    default:
      return html(
        "Not Found",
        `
          <h1>Page Not Found</h1>

          <a href="${route(
            "/",
            mutation,
          )}">
            Return Home
          </a>
        `,
        mutation,
      );
  }
}

export async function startShopFlow(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(
    (req, res) => {
      const requestUrl = new URL(
        req.url ?? "/",
        "http://localhost",
      );

      const mutation =
        requestUrl.searchParams.get(
          "mutation",
        ) === "1";

      const body = pageFor(
        requestUrl.pathname,
        mutation,
      );

      res.writeHead(200, {
        "Content-Type":
          "text/html; charset=utf-8",
      });

      res.end(body);
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(
      0,
      "127.0.0.1",
      resolve,
    );
  });

  const address = server.address();

  if (
    !address ||
    typeof address === "string"
  ) {
    throw new Error(
      "Failed to start ShopFlow server",
    );
  }

  const url =
    `http://127.0.0.1:${address.port}`;

  console.log(
    `[shopflow] server ready at ${url}`,
  );

  return {
    url,

    close: async () => {
      await new Promise<void>(
        (resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        },
      );
    },
  };
}