package com.orderflow.order.web;

import java.util.List;

import com.orderflow.order.correlation.Correlation;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.orderflow.order.service.ServiceExceptions.CancelNotAllowedException;
import com.orderflow.order.service.ServiceExceptions.CheckoutRejectedException;
import com.orderflow.order.service.ServiceExceptions.DependencyUnavailableException;
import com.orderflow.order.service.ServiceExceptions.IdempotencyConflictException;
import com.orderflow.order.service.ServiceExceptions.OrderNotFoundException;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * The ONLY place that formats error responses, using the shape every
 * OrderFlow service shares: {@code { error, message, requestId[, details] }}.
 *
 * <p>Nothing from the database, driver or JVM reaches a client: SQL errors,
 * lock timeouts and connection failures are translated to stable codes with
 * client-facing messages; anything unexpected is logged WITH its stack trace
 * and answered with a generic 500.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    /** Raised by controllers for env-driven limits and cross-field rules. */
    public static class BadRequestException extends RuntimeException {
        private final List<FieldError> details;

        public BadRequestException(List<FieldError> details) {
            super("Validation failed");
            this.details = details;
        }
    }

    // ---- 400 ----------------------------------------------------------------

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> invalidBody(MethodArgumentNotValidException e) {
        List<FieldError> details = e.getBindingResult().getFieldErrors().stream()
                .map(f -> new FieldError(f.getField(), f.getDefaultMessage()))
                .toList();
        if (details.isEmpty()) {
            details = e.getBindingResult().getGlobalErrors().stream()
                    .map(g -> new FieldError(g.getObjectName(), g.getDefaultMessage()))
                    .toList();
        }
        return respond(HttpStatus.BAD_REQUEST, "validation_error", "Validation failed", details);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<ApiError> invalidParam(ConstraintViolationException e) {
        List<FieldError> details = e.getConstraintViolations().stream()
                .map(v -> new FieldError(lastNode(v.getPropertyPath().toString()), v.getMessage()))
                .toList();
        return respond(HttpStatus.BAD_REQUEST, "validation_error", "Validation failed", details);
    }

    @ExceptionHandler(BadRequestException.class)
    public ResponseEntity<ApiError> badRequest(BadRequestException e) {
        return respond(HttpStatus.BAD_REQUEST, "validation_error", "Validation failed", e.details);
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    public ResponseEntity<ApiError> unreadable(Exception e) {
        return respond(HttpStatus.BAD_REQUEST, "invalid_json", "Request body is not valid JSON for this endpoint", null);
    }

    // ---- 404 / 405 / 415 ----------------------------------------------------

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ApiError> noRoute(NoResourceFoundException e) {
        return respond(HttpStatus.NOT_FOUND, "not_found", "No route for " + e.getHttpMethod() + " /" + e.getResourcePath(), null);
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ApiError> methodNotAllowed(HttpRequestMethodNotSupportedException e) {
        return respond(HttpStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "Method " + e.getMethod() + " is not allowed here", null);
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ApiError> unsupportedMedia(HttpMediaTypeNotSupportedException e) {
        return respond(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type", "Request body must be application/json", null);
    }

    /** The error shape shared by every OrderFlow service. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ApiError(String error, String message, String requestId, List<? extends Object> details) {
    }

    public record FieldError(String field, String message) {
    }

    // ---- 401 ----------------------------------------------------------------

    @ExceptionHandler(RequireUserResolver.MissingUserException.class)
    public ResponseEntity<ApiError> unauthorized(RequireUserResolver.MissingUserException e) {
        return respond(HttpStatus.UNAUTHORIZED, "unauthorized", e.getMessage(), null);
    }

    // ---- 404 (also for another user's order — never 403, so ids cannot be probed) ----

    @ExceptionHandler(OrderNotFoundException.class)
    public ResponseEntity<ApiError> orderNotFound(OrderNotFoundException e) {
        return respond(HttpStatus.NOT_FOUND, "order_not_found", "No such order", null);
    }

    // ---- 409 / 422 ----------------------------------------------------------

    @ExceptionHandler(CheckoutRejectedException.class)
    public ResponseEntity<ApiError> checkoutRejected(CheckoutRejectedException e) {
        return respond(HttpStatus.valueOf(e.getStatus()), e.getCode(), e.getMessage(), e.getDetails());
    }

    @ExceptionHandler(IdempotencyConflictException.class)
    public ResponseEntity<ApiError> idempotencyConflict(IdempotencyConflictException e) {
        return respond(HttpStatus.UNPROCESSABLE_ENTITY, "idempotency_key_conflict", e.getMessage(), null);
    }

    @ExceptionHandler(CancelNotAllowedException.class)
    public ResponseEntity<ApiError> cancelNotAllowed(CancelNotAllowedException e) {
        return respond(HttpStatus.CONFLICT, "cancel_not_allowed", e.getMessage(), null);
    }

    // ---- 503: a dependency's circuit breaker fallback -------------------------

    @ExceptionHandler(DependencyUnavailableException.class)
    public ResponseEntity<ApiError> dependencyUnavailable(DependencyUnavailableException e) {
        log.warn("checkout blocked by an unavailable dependency", kv("code", e.getCode()), kv("cause", e.getCause() != null ? e.getCause().getMessage() : null));
        return respond(HttpStatus.SERVICE_UNAVAILABLE, e.getCode(), e.getMessage(), null);
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ApiError> integrity(DataIntegrityViolationException e) {
        // A CHECK / UNIQUE constraint fired that the application logic should have
        // prevented. The database did its job; log it loudly, tell the client little.
        log.error("database constraint rejected a write", kv("constraint", constraintName(e)), e);
        return respond(HttpStatus.CONFLICT, "conflict", "The request conflicts with the current order state. Please retry.", null);
    }

    // ---- 503 ----------------------------------------------------------------

    @ExceptionHandler({PessimisticLockingFailureException.class, QueryTimeoutException.class})
    public ResponseEntity<ApiError> lockTimeout(Exception e) {
        log.warn("could not acquire order row lock in time", kv("cause", e.getClass().getSimpleName()));
        return respond(HttpStatus.SERVICE_UNAVAILABLE, "order_busy",
                "This order is being updated by another request. Please retry.", null);
    }

    @ExceptionHandler({CannotGetJdbcConnectionException.class, CannotCreateTransactionException.class,
            DataAccessResourceFailureException.class})
    public ResponseEntity<ApiError> databaseDown(Exception e) {
        log.error("database unavailable", kv("cause", e.getClass().getSimpleName()));
        return respond(HttpStatus.SERVICE_UNAVAILABLE, "database_unavailable",
                "The order database is temporarily unavailable. Please try again.", null);
    }

    // ---- 500 ----------------------------------------------------------------

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> unhandled(Exception e) {
        log.error("unhandled error", e);
        return respond(HttpStatus.INTERNAL_SERVER_ERROR, "internal_error", "Internal server error", null);
    }

    // -------------------------------------------------------------------------

    private static ResponseEntity<ApiError> respond(HttpStatus status, String code, String message, List<?> details) {
        return ResponseEntity.status(status).body(new ApiError(code, message, Correlation.current(), details));
    }

    private static String lastNode(String path) {
        int dot = path.lastIndexOf('.');
        return dot >= 0 ? path.substring(dot + 1) : path;
    }

    private static String constraintName(DataIntegrityViolationException e) {
        Throwable t = e;
        while (t != null) {
            if (t instanceof org.hibernate.exception.ConstraintViolationException cve && cve.getConstraintName() != null) {
                return cve.getConstraintName();
            }
            t = t.getCause();
        }
        return "unknown";
    }
}
