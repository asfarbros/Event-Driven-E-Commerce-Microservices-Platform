# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# OrderFlow — inventory (Java 17, Spring Boot 3.5). Multi-stage:
#   build   Maven on a JDK image. `dependency:go-offline` runs against the pom
#           ALONE, so the (large) dependency download is a cached layer that
#           survives source changes; the ~/.m2 cache mount survives rebuilds.
#   runtime a JRE-only image. The Spring Boot jar is exploded into its layers
#           (dependencies / loader / snapshots / application) and copied in
#           that order, so a code change invalidates only the last, tiny layer.
#           Runs as an unprivileged user.
#
#   docker build -t orderflow/inventory services/inventory
#
# The OpenTelemetry Java agent is shipped next to the app (pinned via Maven,
# not curl) and activated only when Compose sets
# JAVA_TOOL_OPTIONS=-javaagent:/app/otel-javaagent.jar — no agent, no tracing,
# no other change (host mode).
# -----------------------------------------------------------------------------
ARG OTEL_AGENT_VERSION=2.31.1

FROM maven:3.9.11-eclipse-temurin-17-alpine AS build
ARG OTEL_AGENT_VERSION
WORKDIR /build
COPY pom.xml ./
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:go-offline
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:copy       -Dartifact=io.opentelemetry.javaagent:opentelemetry-javaagent:${OTEL_AGENT_VERSION}       -DoutputDirectory=/build/agent -Dmdep.stripVersion=true
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B -q package -DskipTests  && java -Djarmode=tools -jar target/inventory-service.jar extract --layers --launcher --destination target/extracted

FROM eclipse-temurin:17.0.16_8-jre-alpine
RUN addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --from=build /build/target/extracted/dependencies/ ./
COPY --from=build /build/target/extracted/spring-boot-loader/ ./
COPY --from=build /build/target/extracted/snapshot-dependencies/ ./
COPY --from=build /build/target/extracted/application/ ./
COPY --from=build /build/agent/opentelemetry-javaagent.jar /app/otel-javaagent.jar
USER app
# Heap sized from the container limit (Compose sets it); no fixed -Xmx to fight it.
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-XX:+ExitOnOutOfMemoryError", "org.springframework.boot.loader.launch.JarLauncher"]
