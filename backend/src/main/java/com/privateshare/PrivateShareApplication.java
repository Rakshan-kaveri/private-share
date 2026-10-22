package com.privateshare;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@SpringBootApplication
public class PrivateShareApplication {
  public static void main(String[] args) { SpringApplication.run(PrivateShareApplication.class, args); }
  @Bean WebMvcConfigurer corsConfigurer() {
    return new WebMvcConfigurer() {
      @Override public void addCorsMappings(CorsRegistry registry) {
        String origin = System.getenv().getOrDefault("APP_ORIGIN", "http://localhost:8080");
        registry.addMapping("/api/**").allowedOrigins(origin).allowedMethods("GET", "POST").allowedHeaders("Content-Type");
      }
    };
  }
}
