# BaseRoutes Pattern Guide

This guide shows how to create routes using the enforced BaseRoutes pattern for consistent OpenAPI documentation.

## ✅ **Benefits**

- **Enforced Documentation**: All routes MUST have proper OpenAPI schemas
- **Consistent Error Handling**: Automatic error wrapping and logging
- **Type Safety**: Full TypeScript support with validation
- **Auto-tagging**: Service names automatically added to Swagger tags
- **Standard Responses**: Consistent success/error response format

## 🏗️ **Basic Usage**

### 1. Import BaseRoutes

```typescript
import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';
```

### 2. Extend BaseRoutes Class

```typescript
export class YourServiceRoutes extends BaseRoutes {
  protected serviceName = 'your-service';
  protected serviceInstance: any;

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    const { yourService } = options;
    this.serviceInstance = yourService;

    // Create routes using this.createRoute()
    const queryRoute = this.createRoute({
      method: 'POST',
      url: '/query',
      schema: {
        description: 'Query your service data', // REQUIRED
        tags: ['your-service'], // REQUIRED  
        body: { /* request schema */ },
        response: {
          200: { /* success response schema */ } // REQUIRED
        }
      },
      handler: async (request, reply) => {
        // Your handler logic
      }
    });

    // Register the route
    fastify.route(queryRoute);
  }
}
```

### 3. Export Backwards Compatible Function

```typescript
export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  const routes = new YourServiceRoutes();
  await routes.register(fastify, options);
}
```

## 📋 **Required Fields**

The BaseRoutes pattern **enforces** these required fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | ✅ | Clear description of what the route does |
| `tags` | string[] | ✅ | Swagger grouping tags (service name auto-added) |
| `response[200]` | object | ✅ | Success response schema |
| `handler` | function | ✅ | Route handler implementation |

## 🛠️ **Helper Methods**

### createRoute()
Main method for creating routes with validation:

```typescript
const route = this.createRoute({
  method: 'POST',
  url: '/query',
  schema: { /* required schema */ },
  handler: async (request, reply) => { /* handler */ }
});
```

### createHealthRoute()
Automatically creates a health check endpoint:

```typescript
const healthRoute = this.createHealthRoute();
fastify.route(healthRoute);
// Creates: GET /health
```

## 📝 **Example: Complete Service**

```typescript
import { FastifyInstance } from 'fastify';
import { BaseRoutes } from '../../core/BaseRoutes.js';

export class UsersRoutes extends BaseRoutes {
  protected serviceName = 'users';
  protected serviceInstance: any;

  async register(fastify: FastifyInstance, options: any): Promise<void> {
    const { usersService } = options;
    this.serviceInstance = usersService;

    // Query users
    const queryRoute = this.createRoute({
      method: 'POST',
      url: '/query',
      schema: {
        description: 'Query users with filtering options',
        tags: ['users'],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Filter by name' },
            email: { type: 'string', format: 'email' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    email: { type: 'string' }
                  }
                }
              },
              count: { type: 'integer' }
            }
          }
        }
      },
      handler: async (request, reply) => {
        const users = await usersService.queryUsers(request.body);
        return reply.send({
          success: true,
          data: users,
          count: users.length
        });
      }
    });

    // Create user
    const createRoute = this.createRoute({
      method: 'POST',
      url: '/create',
      schema: {
        description: 'Create a new user',
        tags: ['users'],
        body: {
          type: 'object',
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  created: { type: 'boolean' }
                }
              }
            }
          }
        }
      },
      handler: async (request, reply) => {
        const user = await usersService.createUser(request.body);
        return reply.send({
          success: true,
          data: { id: user.id, created: true }
        });
      }
    });

    // Health check
    const healthRoute = this.createHealthRoute();

    // Register all routes
    fastify.route(queryRoute);
    fastify.route(createRoute);
    fastify.route(healthRoute);
  }
}

export async function register(fastify: FastifyInstance, options: any): Promise<void> {
  const usersRoutes = new UsersRoutes();
  await usersRoutes.register(fastify, options);
}
```

## ❌ **What NOT to Do**

```typescript
// ❌ DON'T: Missing required fields
fastify.post('/query', {
  handler: async (request, reply) => {
    // This will end up in "default" section in Swagger!
  }
});

// ❌ DON'T: Inconsistent error handling  
fastify.post('/query', {
  handler: async (request, reply) => {
    try {
      // logic
    } catch (error) {
      // Manual error handling - BaseRoutes does this automatically!
    }
  }
});
```

## ✅ **Migration from Old Routes**

1. **Add imports**:
   ```typescript
   import { BaseRoutes } from '../../core/BaseRoutes.js';
   ```

2. **Convert to class**:
   ```typescript
   export class YourServiceRoutes extends BaseRoutes {
     protected serviceName = 'your-service';
     // ... rest of implementation
   }
   ```

3. **Use createRoute()**:
   ```typescript
   // Old way:
   fastify.post('/query', { handler: ... });
   
   // New way:
   const route = this.createRoute({
     method: 'POST',
     url: '/query',
     schema: { /* required fields */ },
     handler: async (request, reply) => { /* handler */ }
   });
   fastify.route(route);
   ```

4. **Keep backwards compatibility**:
   ```typescript
   export async function register(fastify: FastifyInstance, options: any): Promise<void> {
     const routes = new YourServiceRoutes();
     await routes.register(fastify, options);
   }
   ```

## 🎯 **Result**

With BaseRoutes pattern:
- ✅ All routes appear in correct Swagger sections
- ✅ Consistent documentation quality
- ✅ Automatic error handling and logging
- ✅ Type safety throughout
- ✅ Enforced best practices

No more routes ending up in the "default" section! 🎉