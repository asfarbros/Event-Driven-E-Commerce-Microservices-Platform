package com.orderflow.order.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Resolves the caller's user id from the gateway-injected {@code X-User-Id}
 * header — the ONLY accepted source of identity. Missing or malformed → 401.
 * There is no fallback to a body field, query parameter or path segment.
 */
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequireUser {
}
